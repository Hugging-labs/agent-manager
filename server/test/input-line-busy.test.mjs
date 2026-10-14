// AM must not type a prompt onto an input line that already holds something.
//
// Sending a prompt means typing it into the TUI and pressing Enter. Nothing
// cleared the composer first — deliberately, since clearing destroys whatever
// the operator typed — so the agent received the two glued together as one
// message (#165): `how are we going on the ` + the prompt sent from the reader,
// submitted as a single line. Harmless that time; the same path can glue a
// half-typed command onto a prompt the agent then acts on.
//
// Detection does not parse composers. AM knows WHAT was typed, because every
// keystroke reaches the PTY through this process, and the grid is used only to
// confirm the text is still on screen. The screens below were captured from the
// eight real CLIs, typing `half typed thought` and never submitting it.
//
// Run with:  node test/input-line-busy.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { inputLineHolds, __notePaneInputForTest as note, __paneInputForTest as pending } from '../src/runner.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCREENS = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures/input-lines.json'), 'utf8'));
const TYPED = 'half typed thought';

let failed = 0;
const check = (what, fn) => {
  try { fn(); console.log(`  ok  ${what}`); } catch (e) {
    failed++; console.log(`  FAIL ${what}\n       ${e.message.split('\n')[0]}`);
  }
};

console.log('\n# the real screens of all eight CLIs');
for (const [harness, states] of Object.entries(SCREENS)) {
  check(`${harness}: unsent text is seen on the input line`, () => {
    assert.equal(inputLineHolds(states.typed, TYPED), true);
  });
  check(`${harness}: an empty input line is not`, () => {
    assert.equal(inputLineHolds(states.empty, TYPED), false);
  });
  check(`${harness}: text that was never typed is not found`, () => {
    assert.equal(inputLineHolds(states.typed, 'a thought nobody had'), false);
  });
}
// All eight settle with the cursor on their composer row, so the row-end test
// is for the states in between — a TUI mid-paint reporting a cursor that is not
// where it has already drawn the composer. Observed on Hermes while booting;
// pinned here as a constructed snapshot rather than a captured one, because a
// transient screen is not something a fixture can hold still.
check('text is still found when the cursor is reported elsewhere', () => {
  const composer = { cursorRow: 0, cursorCol: 0, visibleLines: [
    { row: 0, text: '' }, { row: 1, text: 'some output' }, { row: 2, text: `> ${TYPED}` },
  ] };
  assert.equal(inputLineHolds(composer, TYPED), true, 'the row-end fallback did not fire');
  assert.equal(inputLineHolds(composer, 'never typed this'), false);
});
// …and that fallback must not fire on a tail too short to mean anything.
check('a one-key tail is not hunted for across the screen', () => {
  const busy = { cursorRow: 0, cursorCol: 0, visibleLines: [{ row: 0, text: '' }, { row: 1, text: 'ready' }] };
  assert.equal(inputLineHolds(busy, 'y'), false);
});

console.log('\n# what counts as still being on the line');
const ID = 'ledger-test';
for (const [what, keys, want] of [
  ['plain typing accumulates', ['hel', 'lo'], 'hello'],
  ['Enter submits it', ['hello', '\r'], ''],
  ['backspace takes it back', ['hello', '\x7f\x7f'], 'hel'],
  ['ctrl-U clears the line', ['hello', '\x15'], ''],
  ['ctrl-C clears it too', ['hello', '\x03'], ''],
  ['arrow keys are not text', ['hi', '\x1b[A\x1b[B\x1b[C'], 'hi'],
  ['a bracketed paste is text', ['\x1b[200~pasted\x1b[201~'], 'pasted'],
]) {
  note(ID, '\r');                       // start from an empty line
  for (const k of keys) note(ID, k);
  check(what, () => assert.equal(pending(ID), want));
}
note(ID, '\r');

// ---- and the whole path, through the real server ----
console.log('\n# a prompt sent while the operator has unsent text');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'input-line-busy-'));
const DATA_DIR = path.join(root, 'data'); fs.mkdirSync(DATA_DIR, { recursive: true });
const PUBLIC_DIR = path.join(root, 'public'); fs.mkdirSync(PUBLIC_DIR);
fs.writeFileSync(path.join(PUBLIC_DIR, 'index.html'), '<html>fixture</html>');
const RECEIVED = path.join(root, 'received.jsonl'); fs.writeFileSync(RECEIVED, '');
// A stand-in CLI that records every line it is given, exactly as submitted.
const recorder = path.join(root, 'recorder.cjs');
fs.writeFileSync(recorder, `
const fs = require('node:fs');
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  for (;;) {
    const i = buf.search(/[\\r\\n]/);
    if (i < 0) break;
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (line.length) fs.appendFileSync(process.env.RECEIVED, JSON.stringify(line) + '\\n');
  }
});
process.stdin.resume();
setInterval(() => {}, 1 << 30);
`);

const freePort = () => new Promise((resolve) => {
  const srv = net.createServer();
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(String(port))); });
});
const PORT = await freePort();
const API = `http://127.0.0.1:${PORT}`;
const { SPACE_ID, AM_DISTRIBUTE_SKILLS, ...BASE } = process.env;
const backend = spawn('node', ['src/index.js'], {
  cwd: path.join(HERE, '..'), stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...BASE, PORT, DATA_DIR, PUBLIC_DIR, AM_BASHRC: '/nonexistent', SPACE_HOST: '',
    AM_ALLOW_MISSING_ORIGIN: '1', RECEIVED, AM_TEST_REPAINT_CMD: `${process.execPath} ${recorder}` },
});
let logs = '';
backend.stdout.on('data', (d) => { logs += d; });
backend.stderr.on('data', (d) => { logs += d; });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (await fn()) return true; } catch {} await sleep(250); }
  return false;
};
const post = (p, body) => fetch(API + p, { method: 'POST',
  headers: { 'content-type': 'application/json', 'x-am-request': '1' },
  body: body === undefined ? undefined : JSON.stringify(body) });
const got = () => fs.readFileSync(RECEIVED, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

try {
  if (!await until(() => fetch(`${API}/api/health`).then((r) => r.ok), 60_000)) throw new Error(`server did not start:\n${logs.slice(-1200)}`);
  await post('/api/welcome/seen');
  const made = await (await post('/api/sessions', { cli: 'test-repaint', name: 'busy-line', path: '.' })).json();
  const peer = await (await post('/api/sessions', { cli: 'test-repaint', name: 'peer', path: '.' })).json();
  const id = made.id;
  const ws = new WebSocket(`${API.replace('http', 'ws')}/ws?session=${id}&cols=100&rows=30`,
    { headers: { 'x-am-request': '1' } });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  await sleep(2500);

  const CLEAN = 'a message with nothing in its way';
  const before = got().length;
  const ok = await post(`/api/sessions/${id}/input`, { text: CLEAN });
  await sleep(1500);
  check('an empty input line still takes a prompt', () => {
    assert.equal(ok.status, 200, `POST /input answered ${ok.status}`);
    assert.deepEqual(got().slice(before), [CLEAN]);
  });

  const LEFTOVER = 'how are we going on the ';
  const SENT = "the per line update looks fine to me. what's the status of the login guide?";
  ws.send(JSON.stringify({ t: 'i', d: LEFTOVER }));
  await sleep(900);
  const at = got().length;
  const refused = await post(`/api/sessions/${id}/input`, { text: SENT });
  const body = await refused.json().catch(() => ({}));
  await sleep(1500);
  check('a prompt is refused rather than merged', () => {
    assert.equal(refused.status, 409, `POST /input answered ${refused.status}`);
    assert.deepEqual(got().slice(at), [], 'something reached the agent anyway');
  });
  check('and the refusal says what is in the way', () => {
    const message = String(body.error || body.message || '');
    assert.ok(message.includes('unsent text'), `unhelpful refusal: ${JSON.stringify(message)}`);
    assert.ok(message.includes('how are we going on the'), 'the refusal does not quote the text');
  });
  // The point of refusing rather than clearing: their typing is untouched.
  check('the operator\'s own text is still on the line', () => {
    assert.deepEqual(got().slice(at), [], 'the half-typed line was submitted or destroyed');
  });

  // A peer agent hits the same guard, with nobody watching the pane.
  const peerTry = await fetch(`${API}/api/agents/${id}/prompt?from=${peer.id}`, {
    method: 'POST', headers: { 'content-type': 'text/plain', 'x-am-request': '1' },
    body: 'peer asking for a status update' });
  await sleep(1200);
  check('an agent prompting a peer is refused the same way', () => {
    assert.equal(peerTry.status, 409, `peer prompt answered ${peerTry.status}`);
    assert.deepEqual(got().slice(at), [], 'a peer prompt was merged into the operator\'s line');
  });

  // Recovery: the operator submits their own line, and sending works again.
  ws.send(JSON.stringify({ t: 'i', d: '\r' }));
  await sleep(1200);
  const afterOwn = got().length;
  const again = await post(`/api/sessions/${id}/input`, { text: SENT });
  await sleep(1500);
  check('once they submit it themselves, the prompt goes through', () => {
    assert.equal(again.status, 200, `POST /input answered ${again.status}`);
    assert.deepEqual(got().slice(afterOwn), [SENT]);
  });
  const theirs = got().slice(at, afterOwn);
  console.log(`  what the agent got from their own line: ${JSON.stringify(theirs)}`);
  check('and their own line arrived separately, unmerged', () => {
    assert.equal(theirs.length, 1, 'their line did not arrive on its own');
    assert.equal(theirs[0].trim(), LEFTOVER.trim());
  });
  ws.close();
} finally {
  backend.kill('SIGTERM');
  await sleep(1200);
  try { backend.kill('SIGKILL'); } catch {}
  fs.rmSync(root, { recursive: true, force: true });
}

if (failed) { console.log(`\ninput-line-busy: ${failed} failed`); process.exit(1); }
console.log('\ninput-line-busy: prompts never land on a line that already holds something');
