// Opening a dispatched session's preview must never move the message history.
//
// The operator, on am-dev-2: "if the preview doesnt fit under the icon it moves
// up the whole message history … i dont want the history to move ever for
// this." It did: the card was absolutely positioned INSIDE the conversation
// scroller, so near the bottom it extended past the end, grew scrollHeight, and
// the reader's follow-to-bottom scrolled to the new end. The card is now an
// overlay on document.body, placed against the icon's viewport rect.
//
// What is measured is the requirement itself: the scroller's scrollTop and
// scrollHeight before and after opening a preview — for an icon near the bottom
// of the viewport (the reported case, which must flip ABOVE), near the top
// (stays below), and with a tap on a phone. They must be identical, and the
// card must be inside the viewport.
//
// The real TerminalPane in reader mode, with a synthetic trace and dispatch API.
// Never starts an agent, never opens a real socket.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { chromiumLaunchOptions } from '../../scripts/test-chromium.mjs';

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-preview-'));
const bundle = path.join(tmp, 'fixture.js');
await build({
  stdin: { resolveDir: web, loader: 'tsx', contents: `
    import React from 'react'; import {createRoot} from 'react-dom/client'; import {flushSync} from 'react-dom';
    import TerminalPane from './src/components/TerminalPane';
    class FakeSocket { static OPEN = 1; constructor(){ this.readyState = 0; } send(){} close(){ this.readyState = 3; } }
    window.WebSocket = FakeSocket;
    const T0 = 1759165000000;
    const COUNT = 30;
    const empty = { harness:'claude',harnessLabel:'Fixture',sessionId:'s',title:'',model:null,cwd:null,
      firstTs:0,lastTs:0,usage:null,source:null,sharedBy:null,note:null,truncated:false,total:null,
      userTurns:null,activity:'waiting',generation:'g',revision:'r1' };
    const page = (turns) => ({ ...empty, turns, window:{mode:'bytes',start:0,end:turns.length,atStart:true,atEnd:true,generation:'g',revision:'r1'} });
    // Every turn launches two sessions from one Bash call. The LAST turn's
    // answer is one line, so its icons sit near the bottom of the viewport —
    // where a card below them cannot fit.
    const ts = (i, k) => T0 + i * 60000 + k * 1000;
    const records = Array.from({length: COUNT}, (_, i) => [
      {id:'u'+i,role:'user',ts:ts(i,0),blocks:[{type:'text',text:'Launch the workers for step '+i}]},
      {id:'c'+i,role:'assistant',ts:ts(i,1),blocks:[{type:'tool_use',name:'Bash',text:'curl -X POST "$AM/api/agents?name=w'+i+'&from=$AM_ID"'},{type:'tool_result',text:'{"id":"w"}'}]},
      {id:'a'+i,role:'assistant',ts:ts(i,2),kind:'final',blocks:[{type:'text',text: i === COUNT - 1 ? 'Both are running.'
        : 'Step '+i+' is out.\\n\\n'+Array.from({length: 8 + (i*7)%20},(_,k)=>'line '+k+' of answer '+i).join('\\n')}]},
    ]).flat();
    const longAnswer = Array.from({length: 14}, (_, k) => '- finding ' + k + ': the change is correct and the tests cover it').join('\\n');
    const dispatches = Array.from({length: COUNT}, (_, i) => [0, 1].map((k) => ({
      id: 'd'+i+'-'+k, at: ts(i,1) + 300, kind: 'launch', status: 201, ok: true,
      prompt: 'Review part '+k+' of step '+i+'. Report anything that would break in production.',
      target: { id: 'peer-'+i+'-'+k, name: 'reviewer-'+i+'-'+k, cli: 'claude', color: '#d97757', exists: true, state: 'waiting' },
      exchange: { ended: true, truncated: false, turns: [
        {role:'user',ts:ts(i,1)+900,blocks:[{type:'text',text:'Review part '+k}]},
        {role:'assistant',ts:ts(i,1)+5000,blocks:[{type:'tool_use',name:'Read',text:''},{type:'tool_result',text:''}],usage:{in:900,out:50}},
        {role:'assistant',ts:ts(i,1)+9000,kind:'final',blocks:[{type:'text',text:'**Verdict: ready.**\\n\\n'+longAnswer}],usage:{in:1200,out:300}},
      ] },
    }))).flat();
    window.fixtureApi = {
      window: () => Promise.resolve(page(records)),
      summary: () => Promise.resolve({ ...page([]), total: records.length, userTurns: [] }),
      dispatches: () => Promise.resolve({ id: 'boss', dispatches }),
    };
    let root;
    window.fixture = { mount() {
      root = createRoot(document.getElementById('fixture-root'));
      flushSync(() => root.render(<div className="tile" style={{position:'relative',flex:1,minWidth:0}}><TerminalPane
        session={{id:'boss',cli:'claude',name:'boss',state:'waiting',running:false,everStarted:true,path:null,createdAt:new Date().toISOString()}}
        cli={{id:'claude',label:'Fixture',color:'#777'}} mode="reader" theme="light" zoom={100}
        focused active visible onClose={()=>{}} /></div>));
    } };
  ` }, bundle: true, outfile: bundle, format: 'iife', platform: 'browser',
  define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent',
  plugins: [{ name: 'fixture-api', setup(builder) {
    builder.onResolve({ filter: /^\.\.?(?:\/\.\.)*\/api$/ }, () => ({ path: 'fixture-api', namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ resolveDir: web, loader: 'ts', contents: `
      export * from ${JSON.stringify(path.join(web, 'src/api.ts'))};
      export const getTraceWindow=(...a)=>window.fixtureApi.window(...a);
      export const getTraceSummary=()=>window.fixtureApi.summary();
      export const getSubAgents=()=>Promise.resolve({agents:[]});
      export const getDispatches=()=>window.fixtureApi.dispatches();
      export const sendInput=()=>Promise.resolve({});
    ` }));
  } }],
});

const browser = await chromium.launch(chromiumLaunchOptions());
let failed = 0;
const check = (what, fn) => {
  try { fn(); console.log(`  ok   ${what}`); } catch (e) {
    failed++; console.log(`  FAIL ${what}\n       ${e.message.split('\n')[0]}`);
  }
};

try {
  for (const [label, width, height, touch] of [['desktop', 1100, 800, false], ['phone', 390, 844, true]]) {
    console.log(`\n### ${label} ${width}x${height}`);
    const context = await browser.newContext({ viewport: { width, height }, hasTouch: touch, isMobile: touch });
    const p = await context.newPage();
    const errors = [];
    p.on('pageerror', (e) => errors.push(e.message));
    await p.route('**/*', (route) => route.request().url() === 'http://fixture.test/'
      ? route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><div id="fixture-root" style="display:flex;position:absolute;inset:10px"></div>' })
      : route.abort());
    await p.goto('http://fixture.test/');
    if (fs.existsSync(bundle.replace(/\.js$/, '.css'))) await p.addStyleTag({ path: bundle.replace(/\.js$/, '.css') });
    await p.addStyleTag({ content: fs.readFileSync(path.join(web, 'src/styles.css'), 'utf8')
      + fs.readFileSync(path.join(web, 'src/conversation.css'), 'utf8') });
    await p.addScriptTag({ path: bundle });
    await p.evaluate(() => window.fixture.mount());
    await p.waitForSelector('.cxv-body');
    await p.waitForSelector('.dx-icon', { timeout: 20_000 });
    // settled at the end, the state the operator was in
    await p.waitForFunction(() => {
      const e = document.querySelector('.cxv-body');
      return e.scrollHeight > e.clientHeight && Math.abs(e.scrollHeight - e.scrollTop - e.clientHeight) < 2;
    }, null, { timeout: 20_000 });
    await p.waitForTimeout(600);

    const geometry = () => p.evaluate(() => {
      const el = document.querySelector('.cxv-body');
      return { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight };
    });
    const card = () => p.evaluate(() => {
      const el = document.querySelector('.dx-pop, .dx-sheet');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, cls: el.className,
        inScroller: !!el.closest('.cxv-body'), vw: innerWidth, vh: innerHeight };
    });
    const iconBox = (loc) => loc.evaluate((e) => { const r = e.getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; });
    const open = async (loc) => {
      if (touch) await loc.tap(); else await loc.hover();
      await p.waitForSelector('.dx-pop:not([style*="hidden"]), .dx-sheet', { timeout: 5_000 });
      await p.waitForTimeout(500);   // let any follow-to-bottom or layout settle
    };
    const closeIt = async () => {
      if (touch) await p.locator('.dx-sheet-wrap').click({ position: { x: 5, y: 5 } });
      else {
        // the card's button must be reachable: moving onto it keeps it open
        const pop = await p.locator('.dx-pop').boundingBox();
        await p.mouse.move(pop.x + pop.width - 30, pop.y + pop.height - 15, { steps: 6 });
        await p.waitForTimeout(500);
        const still = await p.locator('.dx-pop').count();
        check('moving onto the card keeps it open, so its Open session button can be reached', () => assert.equal(still, 1));
        await p.mouse.move(2, 2, { steps: 4 });
      }
      await p.waitForFunction(() => !document.querySelector('.dx-pop, .dx-sheet'), null, { timeout: 5_000 });
    };

    // 1. the reported case: the last turn's icon, near the bottom of the viewport
    {
      const icon = p.locator('.dx-icon').last();
      const box = await iconBox(icon);
      const before = await geometry();
      await open(icon);
      const after = await geometry();
      const c = await card();
      check('near the bottom: scrollTop and scrollHeight are identical after opening', () => assert.deepEqual(after, before));
      check('the card is not inside the conversation scroller', () => assert.equal(c.inScroller, false));
      check('and it is entirely on screen', () => {
        assert.ok(c.top >= 0 && c.bottom <= c.vh + 0.5 && c.left >= 0 && c.right <= c.vw + 0.5, JSON.stringify(c));
      });
      if (!touch) check('it opened ABOVE the icon, since it does not fit below', () => {
        assert.match(c.cls, /\babove\b/);
        assert.ok(c.bottom <= box.top, `card bottom ${c.bottom} vs icon top ${box.top}`);
      });
      await closeIt();
      const closed = await geometry();
      check('and closing it moves nothing either', () => assert.deepEqual(closed, before));
    }

    // 2. an icon near the top of the viewport
    {
      await p.evaluate(() => {
        const body = document.querySelector('.cxv-body');
        const icons = [...document.querySelectorAll('.dx-icon')];
        const target = icons[Math.max(0, icons.length - 6)];
        body.scrollTop += target.getBoundingClientRect().top - body.getBoundingClientRect().top - 40;
      });
      await p.waitForTimeout(600);
      const icon = p.locator('.dx-icon').nth(await p.locator('.dx-icon').count() - 6);
      const box = await iconBox(icon);
      const before = await geometry();
      await open(icon);
      const after = await geometry();
      const c = await card();
      check('near the top: scrollTop and scrollHeight are identical after opening', () => assert.deepEqual(after, before));
      if (!touch) check('it opened BELOW the icon, where there is room', () => {
        assert.match(c.cls, /\bbelow\b/);
        assert.ok(c.top >= box.bottom, `card top ${c.top} vs icon bottom ${box.bottom}`);
      });
      check('on screen', () => assert.ok(c.top >= 0 && c.bottom <= c.vh + 0.5 && c.left >= 0 && c.right <= c.vw + 0.5, JSON.stringify(c)));
      if (!touch) {
        // History can scroll while a card is open (live turns, the keyboard):
        // it follows its icon, and closes once the icon has left the reader.
        // Opened from the keyboard with the mouse parked outside, so no other
        // icon scrolls under the pointer and opens its own preview; scrolled
        // with real keys, because the reader re-pins programmatic scrollTop.
        await p.mouse.move(2, 2, { steps: 4 });
        await p.waitForFunction(() => !document.querySelector('.dx-pop'), null, { timeout: 5_000 });
        await p.keyboard.press('Shift');
        await icon.evaluate((e) => e.focus({ preventScroll: true }));
        await p.waitForSelector('.dx-pop:not([style*="hidden"])', { timeout: 5_000 });
        await p.waitForTimeout(300);
        const c1 = await card();
        const b1 = await iconBox(icon);
        await p.keyboard.press('ArrowUp');
        await p.waitForTimeout(400);
        const moved = await card();
        const b2 = await iconBox(icon);
        check('scrolled while open: the card follows its icon', () => {
          assert.ok(moved, 'card closed');
          assert.ok(b2.top !== b1.top, 'the history did not scroll — the check proves nothing');
          assert.ok(Math.abs((moved.top - b2.bottom) - (c1.top - b1.bottom)) < 1, `gap ${moved.top - b2.bottom} vs ${c1.top - b1.bottom}`);
        });
        for (let i = 0; i < 3; i++) await p.keyboard.press('PageUp');
        await p.waitForTimeout(500);
        const gone = await card();
        check('and closes once the icon has scrolled out of the reader', () => assert.equal(gone, null));
        await p.mouse.move(2, 2);
      } else await closeIt();
    }

    check('no page errors', () => assert.deepEqual(errors, [], errors.slice(0, 2).join(' | ')));
    await context.close();
  }
} finally {
  await browser.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} failed` : '\ndispatch-preview: opening a preview never moves the history');
process.exit(failed ? 1 : 0);
