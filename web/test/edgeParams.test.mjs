// A hosting edge may put a sign-in parameter in the address the app is loaded
// at. The app must drop it from the address on boot and never carry it (or any
// other non-app parameter) into a link it builds, a clipboard write, a new tab,
// a request, or a notification click target.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { chromiumLaunchOptions } from '../../scripts/test-chromium.mjs';

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = 'SECRET';
const DIRTY = `?__sign=${SECRET}&other=${SECRET}2&vvdebug=1`;
const leaks = (value) => typeof value === 'string' && (value.includes(SECRET) || value.includes('__sign') || value.includes('other='));

// 1. Boot order: boot.ts must be main.tsx's first import, so it runs before any
//    other module reads `location` at load time.
const main = fs.readFileSync(path.join(web, 'src/main.tsx'), 'utf8');
assert.match(main.split('\n').find((line) => line.startsWith('import ')), /^import '\.\/boot';/, 'boot.ts is the first import of main.tsx');

// 2. No source builds a link from the whole address.
const offenders = [];
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.includes('.test.')) {
      fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        if (/location\.href|document\.URL|location\.search\s*\+|\+\s*location\.search|\$\{location\.search\}/.test(line)
          && !/(lazyModule|appUrl)\.ts$/.test(file)) offenders.push(`${path.relative(web, file)}:${i + 1}`);
      });
    }
  }
};
walk(path.join(web, 'src'));
assert.deepEqual(offenders, [], 'links are built from appUrl/appPath, never the raw address');
console.log('edge-params: source checks passed');

// 3. Service worker: notification clicks open only this app, with app parameters.
{
  const handlers = {};
  const opened = [];
  const self = {
    location: { origin: 'https://space.example' },
    addEventListener: (type, fn) => { handlers[type] = fn; },
    clients: { matchAll: async () => [], openWindow: async (url) => { opened.push(url); }, claim: async () => {} },
    registration: { showNotification: async () => {} },
    skipWaiting: () => {},
  };
  vm.runInNewContext(fs.readFileSync(path.join(web, 'public/sw.js'), 'utf8'), { self, URL, URLSearchParams });
  const click = async (url) => {
    let done;
    handlers.notificationclick({ notification: { data: { url }, close: () => {} }, waitUntil: (p) => { done = p; } });
    await done;
    return opened.at(-1);
  };
  assert.equal(await click(`/${DIRTY}#x`), '/?vvdebug=1#x');
  assert.equal(await click(`https://space.example/a${DIRTY}`), '/a?vvdebug=1');
  assert.equal(await click('https://elsewhere.example/?__sign=SECRET'), '/');
  assert.equal(await click(undefined), '/');
  assert.ok(!opened.some(leaks), 'no notification target carries edge parameters');
  console.log('edge-params: service worker passed');
}

// 4. Browser: the real modules, loaded at a dirty address, top-level and framed.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-params-'));
const bundle = path.join(tmp, 'fixture.js');
await build({
  stdin: { resolveDir: web, loader: 'tsx', contents: `
    import './src/boot';
    import React from 'react'; import { createRoot } from 'react-dom/client';
    import FileLinkContent, { FileLinkScope, FilePreviewContext } from './src/components/FileLinkContent';
    import FileLinkPage from './src/components/FileLinkPage';
    import { PushRow } from './src/components/SettingsView';
    import * as links from './src/lib/fileLinks';
    import * as appUrl from './src/lib/appUrl';
    import { lazyModuleInternals } from './src/lib/lazyModule';
    window.t = { ...links, ...appUrl, fetchPageHtml: lazyModuleInternals.fetchPageHtml };
    const request = links.requestFromHash(location.hash);
    createRoot(document.getElementById('root')).render(request ? <FileLinkPage request={request}/> : <main>
      <FilePreviewContext.Provider value={() => {}}>
        <FileLinkScope session="team"><FileLinkContent html={'<p><a href="./readme.md">Readme</a></p>'}/></FileLinkScope>
      </FilePreviewContext.Provider>
      <PushRow/>
    </main>);
  ` }, bundle: true, outfile: bundle, format: 'iife', platform: 'browser',
  define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent',
});
const requests = [];
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://fixture');
  if (url.pathname === '/fixture.js') { res.setHeader('content-type', 'text/javascript'); return res.end(fs.readFileSync(bundle)); }
  if (url.pathname === '/host') {
    res.setHeader('content-type', 'text/html');
    return res.end(`<!doctype html><iframe id="app" src="/${DIRTY}" style="width:900px;height:600px"></iframe>`);
  }
  if (url.pathname.startsWith('/api/')) {
    res.setHeader('content-type', 'application/json');
    if (url.pathname.endsWith('/resolve')) return res.end(JSON.stringify({ root: 'workspace', path: 'team/readme.md', absolute: '/data/workspaces/team/readme.md' }));
    if (url.pathname.endsWith('/preview')) return res.end(JSON.stringify({ kind: 'markdown', text: '# Readme preview', path: 'team/readme.md', name: 'readme.md', size: 16, mtime: 1 }));
    res.statusCode = 404; return res.end('{}');
  }
  if (url.pathname !== '/') { res.statusCode = 404; return res.end(); }
  res.setHeader('content-type', 'text/html');
  res.end('<!doctype html><div id="root"></div><script src="/fixture.js"></script>');
});
server.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch(chromiumLaunchOptions());
const context = await browser.newContext({ viewport: { width: 1000, height: 760 } });
context.setDefaultTimeout(10_000);
// Record every clipboard write and window.open target in every frame.
await context.addInitScript(() => {
  window.__writes = [];
  const record = (value) => { (window.top.__writes || window.__writes).push(String(value)); };
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (v) => record(v) } });
  const open = window.open.bind(window);
  window.open = (url, ...rest) => { record(url); return open(url, ...rest); };
});
const errors = [];
const opened = [];
context.on('page', (page) => {
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('framenavigated', (frame) => opened.push(frame.url()));
});
context.on('request', (request) => requests.push(request));
const popup = async (action) => {
  const pending = context.waitForEvent('page');
  await action();
  const tab = await pending; await tab.waitForLoadState('domcontentloaded');
  return tab;
};
// Every attribute in the frame's DOM that could be a link.
const attrs = (frame) => frame.evaluate(() => [...document.querySelectorAll('*')].flatMap((el) =>
  [...el.attributes].filter((a) => /^(href|src|action|data-.*)$/.test(a.name)).map((a) => a.value)));
const writes = [];
try {
  // 4a. Framed, as the Hub page embeds the Space.
  const host = await context.newPage();
  await host.goto(`${origin}/host`);
  const frame = host.frames().find((f) => f !== host.mainFrame());
  await frame.waitForFunction(() => !!window.t);
  assert.equal(new URL(frame.url()).search, '?vvdebug=1', 'framed address keeps only app parameters');
  assert.equal(await frame.evaluate(() => location.search), '?vvdebug=1');
  const values = await frame.evaluate(() => {
    const r = { file: 'team/readme.md', session: 'team', line: 3 };
    return [t.fileLinkUrl(r), t.appPath(), t.appUrl(), t.appUrl('#x'), t.appSearch()];
  });
  assert.equal(values[0], '/?vvdebug=1#file=team%2Freadme.md&session=team&line=3');
  assert.equal(values[2], `${origin}/?vvdebug=1`);
  for (const value of values) assert.ok(!leaks(value), 'generated link is clean');
  const direct = frame.getByRole('link', { name: /Open directly/ });
  await direct.waitFor();
  assert.equal(await direct.getAttribute('href'), `${origin}/?vvdebug=1`);
  let tab = await popup(() => direct.click());
  assert.ok(!leaks(tab.url()), 'Open directly target is clean'); await tab.close();
  // Ctrl/Cmd-click on a rendered file link and activateFileLink both open a tab.
  const readme = frame.getByRole('link', { name: 'Readme' });
  assert.ok(!leaks(await readme.getAttribute('href')));
  tab = await popup(() => readme.click({ modifiers: ['ControlOrMeta'] }));
  assert.ok(!leaks(tab.url()), 'modified click target is clean'); await tab.close();
  tab = await popup(() => frame.evaluate(() => t.activateFileLink(new MouseEvent('click', { ctrlKey: true }), { file: 'team/readme.md' })));
  assert.ok(!leaks(tab.url()), 'activateFileLink target is clean'); await tab.close();
  assert.ok(await frame.evaluate(() => t.fetchPageHtml()), 'page HTML refetch still works');
  for (const value of await attrs(frame)) assert.ok(!leaks(value), `DOM attribute is clean: ${value}`);
  writes.push(...await host.evaluate(() => window.__writes));
  console.log('edge-params: framed app passed');

  // 4b. Top-level copied-link page: replaceState, "Agent Manager ↗" and "Copy link".
  const page = await context.newPage();
  await page.goto(`${origin}/${DIRTY}#file=readme.md&session=team`);
  await page.getByRole('heading', { name: 'Readme preview' }).waitFor();
  await page.waitForFunction(() => location.hash.includes('root=workspace'));
  assert.ok(!leaks(page.url()), 'address after canonical replaceState is clean');
  assert.equal(new URL(page.url()).search, '?vvdebug=1');
  assert.equal(await page.getByRole('link', { name: /Agent Manager/ }).getAttribute('href'), '/?vvdebug=1');
  await page.getByRole('button', { name: 'Copy link' }).click();
  await page.getByRole('status').filter({ hasText: 'Link copied' }).waitFor();
  const copied = await page.evaluate(() => window.__writes);
  assert.deepEqual(copied, [`${origin}/?vvdebug=1#file=team%2Freadme.md&root=workspace`]);
  writes.push(...copied);
  for (const value of await attrs(page)) assert.ok(!leaks(value), `DOM attribute is clean: ${value}`);
  console.log('edge-params: file link page passed');

  // 4c. Nothing else left the page carrying the parameters.
  for (const value of writes) assert.ok(!leaks(value), 'clipboard/window.open value is clean');
  const dirty = new Set([`${origin}/${DIRTY}`, `${origin}/${DIRTY}#file=readme.md&session=team`]);
  for (const request of requests) {
    if (request.isNavigationRequest() && dirty.has(request.url())) continue; // the address we loaded
    assert.ok(!leaks(request.url()), `request is clean: ${request.url()}`);
  }
  for (const url of opened) if (!dirty.has(url)) assert.ok(!leaks(url), `navigation is clean: ${url}`);
  assert.deepEqual(errors, []);
  console.log('edge-params: all checks passed');
} finally {
  await browser.close(); await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
}
