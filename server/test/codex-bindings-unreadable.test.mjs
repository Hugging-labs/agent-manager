// What an unreadable /data/codex-bindings.json may and may not stop.
//
// The file is AM's own record of which AM session owns which shared Codex
// thread, and it is consulted on EVERY Codex launch — before the pilot flags
// are looked at. So one malformed byte used to refuse every Codex session on
// the box, on hosts that had never enabled the pilot, with a bare 503 that
// named neither the file nor the repair.
//
// It cannot simply fail open. A binding written while the pilot was on outlives
// the flag: switching it off does not delete the file, and letting such a
// session start a standalone TUI would put a second writer on a thread the
// shared server owns. What makes the distinction safe is that every record is
// written by bindExistingThread, which refuses unless the session's own
// `codexSessionId` already equals the thread — so a Codex session with no
// verified thread pin provably has no usable binding, and an unreadable file
// says nothing about it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import test from 'node:test';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-bindings-unreadable-'));
process.env.DATA_DIR = dir;
delete process.env.AM_CODEX_BINDINGS_PILOT;
delete process.env.AM_CODEX_SHARED_CREATE;
fs.mkdirSync(path.join(dir, 'workspaces', 'w'), { recursive: true });
const FILE = path.join(dir, 'codex-bindings.json');

const { assertCodexLaunchAllowed, boundOrUnknown, bindingCouldExist } = await import('../src/codex-launch-policy.js');
const { CodexBindings, endpointIdentity } = await import('../src/codex-bindings.js');
const { commandFor } = await import('../src/runner.js');

const THREAD = '11111111-1111-4111-8111-111111111111';
const codex = (extra = {}) => ({ id: `s-${crypto.randomBytes(4).toString('hex')}`, cli: 'codex',
  sessionUuid: crypto.randomUUID(), path: 'w', everStarted: true, ...extra });
const corrupt = () => fs.writeFileSync(FILE, '{"version":1,"bindings":[');
const clear = () => { try { fs.unlinkSync(FILE); } catch {} };
const refusal = (session) => {
  try { assertCodexLaunchAllowed(session); return null; } catch (error) { return error; }
};

test('with no bindings file, an ordinary Codex session launches', () => {
  clear();
  assert.equal(refusal(codex()), null);
  assert.equal(refusal(codex({ codexSessionId: THREAD })), null);
});

test('an unreadable bindings file does not hold an unbindable Codex session hostage', () => {
  corrupt();
  // No verified thread pin: bindExistingThread could never have bound it, so
  // the file has nothing to say about this session.
  assert.equal(bindingCouldExist(codex()), false);
  assert.equal(refusal(codex()), null, 'an ordinary Codex session still opens');
  assert.equal(refusal({ ...codex(), cli: 'claude' }), null, 'and other agents were never affected');
});

test('an unreadable bindings file still refuses anything that could be bound', () => {
  corrupt();
  // The case that must not fail open: the pilot WAS on, this session was bound
  // by its pin, the flag is off again, and the file no longer parses.
  const pinned = codex({ codexSessionId: THREAD });
  assert.equal(bindingCouldExist(pinned), true);
  const byPin = refusal(pinned);
  assert.equal(byPin?.code, 'codex-bindings-unreadable');
  // 409, not 503: errorEnvelope replaces every 5xx body, so a 503 could not
  // tell the operator what to repair however it was worded.
  assert.equal(byPin?.statusCode, 409);

  const imported = codex({ codexSharedOnly: true });
  assert.equal(refusal(imported)?.code, 'codex-bindings-unreadable');

  process.env.AM_CODEX_BINDINGS_PILOT = '1';
  try { assert.equal(refusal(codex())?.code, 'codex-bindings-unreadable', 'with the pilot on, nothing is assumed'); }
  finally { delete process.env.AM_CODEX_BINDINGS_PILOT; }
});

test('the refusal names the file and what repairing it costs', () => {
  corrupt();
  const error = refusal(codex({ codexSessionId: THREAD }));
  assert.match(error.message, /codex-bindings\.json/);
  assert.match(error.message, /remove it to unbind every shared task/);
  assert.match(error.message, /will not start a standalone one/);
  // The file name survives errorEnvelope's 5xx/4xx filtering; an absolute path
  // would not, which is why it goes to the log instead.
  assert.deepEqual(error.data?.details, [{ field: 'path', message: 'codex-bindings.json' }]);
  assert.ok(error.statusCode < 500, 'a 5xx body would be replaced wholesale');
});

test('background bookkeeping treats an unreadable file as bound, and never throws', () => {
  corrupt();
  const session = codex();
  // The rollout re-pin, breadcrumb capture and stale-pin clear ask this. They
  // run on timers with no request to answer, and re-pinning a bound session is
  // the harmful direction.
  assert.equal(boundOrUnknown(session), true);
  assert.equal(boundOrUnknown(session.id), true);
  clear();
  assert.equal(boundOrUnknown(session), false);
});

test('a real binding still keeps its session off the standalone launch path', () => {
  clear();
  const bindings = new CodexBindings(FILE);
  const session = codex({ codexSessionId: THREAD });
  bindings.bind({ session, threadId: THREAD, expectedRevision: 0,
    cwd: fs.realpathSync(path.join(dir, 'workspaces', 'w')),
    endpointId: endpointIdentity({ socket: '/tmp/s.sock', home: '/tmp/codex-home', uid: process.getuid() }) });
  const command = commandFor(session);
  assert.match(command, /am-codex-context\.mjs/, 'a bound session launches through the shared client');
  assert.doesNotMatch(command, /exec codex/, 'never a standalone writer');
});

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
