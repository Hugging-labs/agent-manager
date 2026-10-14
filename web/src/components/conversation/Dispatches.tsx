// The sessions this turn handed work to, drawn as the reader's own marks: one
// CLI logo per session inside the StateLogo frame — the running animation, the
// ordinary finished frame, and the same frame in red when the records prove it
// failed. No checkmark: a finished turn says the peer stopped, not that it did
// the job, and the preview's last message is what says the rest.
//
// Hover shows a preview; a click opens the session. Touch has no hover, so the
// first tap shows the preview (as a sheet) and its button opens the session.
// The preview always carries that button, on every device.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import StateLogo from '../StateLogo';
import { renderMarkdown } from '../../lib/markdown';
import { fmtClock, fmtDur, fmtTok, oneLine } from './exchanges';
import { openSession, ordered, type DispatchResult, type PeerIcon } from '../../lib/dispatches';

const ENVELOPE = /^(?:\s*\[message from [^\]]*\]\s*)+/;
const plainPrompt = (t: string) => oneLine(t.replace(ENVELOPE, '').replace(/^#+\s*/gm, '').replace(/\*\*|`/g, ''), 280);

const WORD: Record<DispatchResult['outcome'], string> = {
  running: 'running', queued: 'not started yet', finished: 'finished', failed: 'failed', gone: 'deleted', unknown: 'state unknown',
};

export function DispatchIcon({ p, size = 12 }: { p: PeerIcon; size?: number }) {
  return (
    <span className={`dx-logo${p.side === 'failed' ? ' bad' : ''}${p.exists ? '' : ' gone'}`}>
      <StateLogo cli={p.cli} state={p.frame} size={size} tint={p.color || undefined} />
    </span>
  );
}

function Preview({ p }: { p: PeerIcon }) {
  const r = p.latest;
  const x = r.x;
  const html = useMemo(() => (r.answer ? renderMarkdown(r.answer) : ''), [r.answer]);
  const facts = x ? [`${x.toolCalls} tool${x.toolCalls === 1 ? '' : 's'}`, fmtDur(x.endTs - x.startTs), x.tokens ? `${fmtTok(x.tokens)} tok` : '']
    .filter(Boolean).join(' · ') : '';
  const first = p.results[0].d;
  return (
    <div className="dx-card" role="dialog" aria-label={`${p.name}: preview`}>
      <div className="dx-card-head">
        <DispatchIcon p={p} size={14} />
        <span className="dx-card-name">{p.name}</span>
        <span className={`dx-word ${r.outcome}`}>{WORD[r.outcome]}{r.why && r.outcome === 'failed' ? ` · ${r.why}` : ''}</span>
      </div>
      <div className="dx-card-sub mono">
        {first.kind === 'launch' ? 'launched' : 'prompted'} {fmtClock(first.at)}
        {p.results.length > 1 ? ` · ${p.results.length} prompts this turn, latest ${fmtClock(r.d.at)}` : ''}
      </div>
      <div className="cx dx-nested">
        <div className="cx-prompt"><div className="markdown cx-pmd dx-clamp">{plainPrompt(r.d.prompt)}</div></div>
        {facts ? <div className="cx-meta mono"><span className="cx-fold flat">{facts}</span></div> : null}
        {r.outcome === 'running' ? <div className="cx-running mono">working</div>
          : html ? <div className="cx-answer dx-answer"><div className="markdown cx-md" dangerouslySetInnerHTML={{ __html: html }} /></div>
            : <div className="dx-none mono">{r.outcome === 'queued' ? 'Waiting for it to take the prompt.'
              : r.outcome === 'gone' ? 'This session has been deleted.'
                : r.outcome === 'unknown' ? 'Its transcript cannot be read here.'
                  : r.why === 'never started' ? 'The prompt never started a turn.' : 'Ended without a final message.'}</div>}
      </div>
      <div className="dx-card-foot">
        <button className="dx-open mono" disabled={!p.exists || !p.targetId}
                onClick={() => { if (p.targetId) openSession(p.targetId); }}>Open session ›</button>
      </div>
    </div>
  );
}

/**
 * Hover and tap, shared by the strip and the step row. A mouse previews on
 * enter and opens on click; a touch previews on the first tap. The card stays
 * while the pointer is on it, so its button can be reached.
 */
function usePreview() {
  const [open, setOpen] = useState<{ key: string; sheet: boolean } | null>(null);
  const timer = useRef<number>();
  const lastPointer = useRef<string>('mouse');
  const cancel = () => window.clearTimeout(timer.current);
  const close = () => { cancel(); setOpen(null); };
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [open]);
  useEffect(() => () => cancel(), []);
  const bind = (p: PeerIcon) => ({
    onPointerDown: (e: React.PointerEvent) => { lastPointer.current = e.pointerType; },
    onPointerEnter: (e: React.PointerEvent) => { if (e.pointerType === 'mouse') { cancel(); setOpen({ key: p.key, sheet: false }); } },
    onPointerLeave: (e: React.PointerEvent) => { if (e.pointerType === 'mouse') { cancel(); timer.current = window.setTimeout(() => setOpen(null), 220); } },
    // Keyboard focus previews; the focus a tap or a click gives a button must
    // not, or the tap that follows would read as the second one and navigate.
    onFocus: (e: React.FocusEvent<HTMLElement>) => { if (e.currentTarget.matches(':focus-visible')) setOpen({ key: p.key, sheet: false }); },
    onClick: () => {
      if (lastPointer.current !== 'mouse' && !(open && open.key === p.key)) { setOpen({ key: p.key, sheet: true }); return; }
      if (p.exists && p.targetId) openSession(p.targetId);
    },
  });
  const card = {
    onPointerEnter: (e: React.PointerEvent) => { if (e.pointerType === 'mouse') cancel(); },
    onPointerLeave: (e: React.PointerEvent) => { if (e.pointerType === 'mouse') { cancel(); timer.current = window.setTimeout(() => setOpen(null), 220); } },
  };
  return { open, close, bind, card };
}

function Floating({ p, sheet, card, close, style }: {
  p: PeerIcon; sheet: boolean; close: () => void; style?: CSSProperties;
  card: { onPointerEnter: (e: React.PointerEvent) => void; onPointerLeave: (e: React.PointerEvent) => void };
}) {
  if (sheet) {
    return createPortal(
      <div className="dx-sheet-wrap" onClick={close}>
        <div className="dx-sheet" onClick={(e) => e.stopPropagation()}><div className="dx-grab" /><Preview p={p} /></div>
      </div>, document.body);
  }
  return <div className="dx-pop" style={style} {...card}><Preview p={p} /></div>;
}

type Pos = HTMLElement & { _l?: number; _t?: number };
const remember = (el: HTMLElement) => el.querySelectorAll<Pos>('[data-k]').forEach((n) => {
  const r = n.getBoundingClientRect(); n._l = r.left; n._t = r.top;
});

/**
 * The strip on the summary line. Reorders when a session finishes — sliding,
 * with a small lift on the one that moved — and holds still while a preview
 * is open, so nothing moves under the pointer.
 */
export function DispatchStrip({ icons }: { icons: PeerIcon[] }) {
  const { open, close, bind, card } = usePreview();
  const held = useRef<string[]>([]);
  let order = ordered(icons).map((p) => p.key);
  if (open && held.current.length) {
    const known = held.current.filter((k) => order.includes(k));
    order = [...known, ...order.filter((k) => !known.includes(k))];
  }
  held.current = order;
  const byKey = new Map(icons.map((p) => [p.key, p]));
  const box = useRef<HTMLSpanElement>(null);
  const seen = useRef(new Set<string>());
  const lastOrder = useRef('');
  const lastSide = useRef(new Map<string, string>());
  useLayoutEffect(() => {
    const el = box.current; if (!el) return;
    const sig = order.join('|');
    const reordered = !!lastOrder.current && sig !== lastOrder.current;
    lastOrder.current = sig;
    const moved = new Set(order.filter((k) => lastSide.current.has(k) && lastSide.current.get(k) !== byKey.get(k)?.side));
    lastSide.current = new Map(order.map((k) => [k, byKey.get(k)!.side]));
    const still = !reordered || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.querySelectorAll<Pos>('[data-k]').forEach((n) => {
      const k = n.dataset.k!;
      const r = n.getBoundingClientRect();
      if (!still && n.animate) {
        if (!seen.current.has(k)) {
          n.animate([{ opacity: 0, transform: 'scale(0.4)' }, { opacity: 1, transform: 'none' }], { duration: 260, easing: 'ease-out' });
        } else if (n._l !== undefined && (n._l !== r.left || n._t !== r.top)) {
          const dx = n._l - r.left; const dy = (n._t ?? r.top) - r.top; const lift = moved.has(k) ? 6 : 0;
          n.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: `translate(${dx / 2}px, ${dy / 2 - lift}px)` }, { transform: 'none' }],
            { duration: 560, easing: 'cubic-bezier(.2,.75,.25,1)' });
        }
      }
      seen.current.add(k);
    });
    remember(el);
  });
  useEffect(() => {
    const el = box.current; if (!el) return;
    const upd = () => remember(el);
    // the reader scrolls inside its own element, so listen in the capture phase
    window.addEventListener('scroll', upd, { capture: true, passive: true });
    window.addEventListener('resize', upd);
    return () => { window.removeEventListener('scroll', upd, { capture: true }); window.removeEventListener('resize', upd); };
  }, []);
  const shown = open ? byKey.get(open.key) : undefined;
  return (
    <span className="dx-strip" ref={box}>
      {order.map((k) => {
        const p = byKey.get(k)!;
        return (
          <button key={k} data-k={k} type="button" className={`dx-icon${open?.key === k ? ' on' : ''}`}
                  aria-label={`${p.name}: ${WORD[p.latest.outcome]}`} {...bind(p)}>
            <DispatchIcon p={p} />
          </button>
        );
      })}
      {shown ? <Floating p={shown} sheet={open!.sheet} card={card} close={close} /> : null}
    </span>
  );
}

/**
 * The step row: the tool call that launched or prompted sessions, in place of
 * the `Bash` line it was. One row per call, so a loop that launched three is
 * one row with three sessions on it.
 */
export function DispatchRow({ icons, failed, mark }: { icons: PeerIcon[]; failed?: boolean; mark?: ReactNode }) {
  const { open, close, bind, card } = usePreview();
  const kinds = new Set(icons.flatMap((p) => p.results.map((r) => r.d.kind)));
  const verb = kinds.size > 1 ? 'dispatched' : kinds.has('launch') ? 'launched' : 'prompted';
  const shown = open ? icons.find((p) => p.key === open.key) : undefined;
  return (
    <div className="cs agent dx-row">
      <div className="cs-head">
        {mark ?? <span className={`cs-mark ${failed ? 'bad' : 'ok'}`}>{failed ? '✗' : '✓'}</span>}
        <span className="cs-label mono">{verb}{icons.length > 1 ? ` ×${icons.length}` : ''}</span>
        <span className="dx-chips">
          {icons.map((p) => (
            <button key={p.key} type="button" className={`dx-chip${open?.key === p.key ? ' on' : ''}`} {...bind(p)}>
              <DispatchIcon p={p} size={10} /><span className="dx-chip-name">{p.name}</span>
            </button>
          ))}
        </span>
      </div>
      {shown ? <Floating p={shown} sheet={open!.sheet} card={card} close={close} /> : null}
    </div>
  );
}
