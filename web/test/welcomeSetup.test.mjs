// First-run setup: the step that turns a fresh Space into a working agent.
//
// What matters here is that the window tells the truth about THIS Space. The
// state it shows comes from the live catalog (`ready`, the same signal behind
// the dot in Settings -> Agents) and the live secret list, so the checks below
// drive it with fixture catalogs and assert what a new operator would read.
//
// The sign-in commands are asserted by name on purpose. `codex login` serves a
// localhost:1455 redirect that a browser cannot reach from a Space — the CLI
// itself says to use `--device-auth` on a remote machine — so offering the
// plain form would be instructions for a flow that cannot complete.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { chromiumLaunchOptions } from '../../scripts/test-chromium.mjs';

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'welcome-setup-'));
const bundle = path.join(tmp, 'fixture.js');

const cli = (id, label, color, ready, secrets, signIn) =>
  ({ id, label, color, available: true, ready, secrets, signIn });
const CATALOG = (ready = []) => [
  cli('claude', 'Claude Code', '#d97757', ready.includes('claude'), ['ANTHROPIC_API_KEY'], 'claude auth login'),
  cli('codex', 'Codex', '#5eb6a6', ready.includes('codex'), ['OPENAI_API_KEY'], 'codex login --device-auth'),
  cli('gemini', 'Gemini CLI', '#4796e3', ready.includes('gemini'), ['GEMINI_API_KEY'], null),
];

await build({
  stdin: { resolveDir: web, loader: 'tsx', contents: `
    import React from 'react'; import { createRoot } from 'react-dom/client';
    import Welcome from './src/components/Welcome';
    import { configuredCount, setupCandidates } from './src/components/WelcomeSetup';
    window.configuredCount = configuredCount;
    window.setupCandidates = setupCandidates;
    window.started = [];
    window.render = (s) => {
      document.getElementById('root').innerHTML = '';
      createRoot(document.getElementById('root')).render(React.createElement(Welcome, {
        onClose: () => { window.closed = true; },
        clis: s.clis, spaceId: s.spaceId ?? 'you/am',
        presentSecrets: s.secrets || [], bucketUnverified: !!s.unverified,
        onStartSession: (c) => window.started.push(c),
      }));
    };
  ` },
  outfile: bundle, bundle: true, format: 'iife', platform: 'browser', logLevel: 'error',
  define: { 'process.env.NODE_ENV': '"production"' },
});

let failed = 0;
const check = async (what, fn) => {
  // Awaited: an async assertion passed to a sync runner throws into a dropped
  // promise and reports ok, which is a test that cannot fail.
  try { await fn(); console.log(`  ok  ${what}`); } catch (e) {
    failed++; console.log(`  FAIL ${what}\n       ${e.message.split('\n')[0]}`);
  }
};
const browser = await chromium.launch(chromiumLaunchOptions());
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const mount = async (state) => {
    await page.setContent(`<style>${fs.readFileSync(path.join(web, 'src/styles.css'), 'utf8')}</style><div id="root"></div>`);
    await page.addScriptTag({ path: bundle });
    await page.evaluate((s) => window.render(s), state);
    await page.waitForSelector('.welcome-card');
    await page.waitForTimeout(120);
  };
  const text = () => page.locator('.welcome-card').innerText();

  console.log('\na fresh Space, nothing configured');
  await mount({ clis: CATALOG([]) });
  const fresh = await text();
  await check('opens on setup, not on the tour', () => assert.match(fresh, /Connect your first agent/));
  await check('says nothing is signed in', () => assert.match(fresh, /Nothing is signed in yet/));
  await check('every agent reads as needing setup', () => {
    assert.equal((fresh.match(/needs setup/g) || []).length, 3);
  });
  await check('offers the sign-in command that works on a remote machine', () =>
    assert.match(fresh, /codex login --device-auth/));
  await check('and never the localhost form a Space cannot complete', () =>
    assert.ok(!/codex login(?! --device-auth)/.test(fresh), 'plain `codex login` was offered'));
  await check('names the secret for each agent', () => {
    assert.match(fresh, /ANTHROPIC_API_KEY/); assert.match(fresh, /OPENAI_API_KEY/);
  });
  await check('warns that adding a secret restarts the Space', () =>
    assert.match(fresh, /restarts this Space/));
  await check('says so for an agent with no confirmed remote sign-in', () =>
    assert.match(fresh, /have not confirmed a sign-in flow for Gemini CLI/));

  const href = await page.locator('a.setup-go').first().getAttribute('href');
  await check(' deep-links to this Space\'s settings', () =>
    assert.equal(href, 'https://huggingface.co/spaces/you/am/settings'));

  await page.locator('.setup-row').filter({ hasText: 'Claude Code' }).locator('button.setup-go').click();
  await check('opening a session asks for that agent', async () =>
    assert.deepEqual(await page.evaluate(() => window.started), ['claude']));

  console.log('\npartly configured');
  await mount({ clis: CATALOG(['claude']), secrets: ['OPENAI_API_KEY'] });
  await page.locator('.btn-ghost').click();   // one agent works, so it opened on the tour
  await page.waitForTimeout(80);
  const part = await text();
  await check('counts what already works', () => assert.match(part, /1 of 3/));
  await check('a ready agent offers a session instead of setup', () =>
    assert.match(part, /Signed in\. Its login is kept on your bucket\./));

  await mount({ clis: CATALOG(['codex']), secrets: ['OPENAI_API_KEY'] });
  await page.locator('.btn-ghost').click();   // one agent works, so it opened on the tour
  await check('and says WHICH secret is doing the work', async () =>
    assert.match(await text(), /Using the OPENAI_API_KEY secret/));

  console.log('\nprivacy not verified');
  await mount({ clis: CATALOG([]), unverified: true });
  await check('warns before inviting any credential', async () =>
    assert.match(await text(), /Check this Space is private before signing in/));
  await mount({ clis: CATALOG([]) });
  await check('and says nothing when the bucket is verified', async () =>
    assert.ok(!/Check this Space is private/.test(await text())));

  console.log('\nwhich step opens, and the way between them');
  await mount({ clis: CATALOG(['claude']) });
  await check('an already-working Space opens on the tour', async () =>
    assert.match(await text(), /Welcome to Agent Manager/));
  await page.locator('.btn-ghost').click();
  await check('and setup is one click back from it', async () =>
    assert.match(await text(), /Connect your first agent/));
  await page.locator('.btn-ghost').click();
  await check('the tour is one click forward from setup', async () =>
    assert.match(await text(), /Welcome to Agent Manager/));

  console.log('\nthe rule that decides whether it reappears');
  const counts = await page.evaluate(() => ({
    none: window.configuredCount([
      { id: 'claude', available: true, ready: false, secrets: ['A'], signIn: 'x' },
      { id: 'shell', available: true, ready: true },
    ]),
    one: window.configuredCount([
      { id: 'claude', available: true, ready: true, secrets: ['A'], signIn: 'x' },
    ]),
    missingBinary: window.setupCandidates([
      { id: 'codex', available: false, ready: false, secrets: ['B'], signIn: 'y' },
    ]).length,
  }));
  // App.tsx reopens the window on each load while this is 0, so a reader who
  // dismisses setup before configuring anything is not stranded.
  await check('a shell does not count as a configured agent', () => assert.equal(counts.none, 0));
  await check('one working agent does', () => assert.equal(counts.one, 1));
  await check('an agent missing from the image is not offered', () => assert.equal(counts.missingBinary, 0));

  await check('no page errors', () => assert.deepEqual(errors, [], errors[0]));
} finally {
  await browser.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} failed` : '\nwelcome-setup: ok');
process.exit(failed ? 1 : 0);
