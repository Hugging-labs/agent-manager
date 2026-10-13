import { useState } from 'react';
import type { Cli } from '../types';
import { KeyGlyph, LockGlyph, PlusGlyph } from './icons';

// First-run SETUP: which agents can actually run, and the two honest ways to
// make one work. The tour next door explains what the product does; this
// answers the only question a brand-new operator has, which is how to get a
// single agent answering them.
//
// Everything here is live. `ready` is the same signal behind the coloured dot
// in Settings -> Agents (isConfigured in server/src/config.js), and `secrets`
// and `signIn` come from the same catalog, so this window cannot drift out of
// step with what the app will actually do.

/** Which agents are worth offering: real CLIs, present in this image. */
export const setupCandidates = (clis: Cli[]) =>
  clis.filter((c) => c.available && (c.secrets?.length || c.signIn));

export const configuredCount = (clis: Cli[]) => setupCandidates(clis).filter((c) => c.ready).length;

export default function WelcomeSetup({
  clis, spaceId, presentSecrets, bucketUnverified, onStartSession, onTour, onClose,
}: {
  clis: Cli[];
  spaceId: string | null;
  /** Secret names already injected into this Space, from /api/info. */
  presentSecrets: string[];
  /** The Space is private but its bucket could not be verified as private. */
  bucketUnverified: boolean;
  onStartSession: (cli: string) => void;
  onTour: () => void;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState<string | null>(null);
  const agents = setupCandidates(clis);
  const ready = agents.filter((c) => c.ready);
  const have = new Set(presentSecrets);
  // The Space's own settings page, built rather than described — that is where
  // secrets are added, and it is two clicks deep otherwise.
  const settingsUrl = spaceId ? `https://huggingface.co/spaces/${spaceId}/settings` : null;

  const copy = (text: string) => {
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(text);
      window.setTimeout(() => setCopied((c) => (c === text ? null : c)), 1400);
    }, () => {});
  };

  return (
    <>
      <div className="welcome-head">
        <span className="welcome-mark"><PlusGlyph /></span>
        <div>
          <h2 id="welcome-title">Connect your first agent</h2>
          <p>
            {ready.length
              ? <><b>{ready.length} of {agents.length}</b> agents are ready to run. Start one, or set up another below.</>
              : <>Nothing is signed in yet. Pick an agent and use either route — both persist across restarts.</>}
          </p>
        </div>
      </div>

      {bucketUnverified && (
        <div className="setup-warn" role="status">
          <span className="setup-warn-ico"><LockGlyph /></span>
          <div>
            <b>Check this Space is private before signing in.</b> Agent Manager has no login of its
            own, so anyone who can open this Space can use the credentials you add here. Its storage
            bucket could not be verified as private.
          </div>
        </div>
      )}

      <div className="setup-list">
        {agents.map((c) => {
          const held = (c.secrets || []).filter((k) => have.has(k));
          return (
            <div key={c.id} className={`setup-row${c.ready ? ' ok' : ''}`}>
              <div className="setup-agent">
                <span className="setup-dot" style={{ background: c.ready ? c.color : 'transparent', borderColor: c.color }} />
                <span className="setup-name">{c.label}</span>
                <span className="setup-state mono">{c.ready ? 'ready' : 'needs setup'}</span>
              </div>
              {c.ready ? (
                <div className="setup-ways">
                  <span className="setup-ready-note">
                    {held.length ? <>Using the <span className="mono">{held[0]}</span> secret.</> : <>Signed in. Its login is kept on your bucket.</>}
                  </span>
                  <button className="btn-primary setup-go" onClick={() => onStartSession(c.id)}>Start a session</button>
                </div>
              ) : (
                <div className="setup-ways">
                  {c.signIn ? (
                    <div className="setup-way">
                      <div className="setup-way-head">Sign in with your subscription</div>
                      <p>
                        Open a session and run this in the pane. It prints a link and a code to
                        bring back — no browser redirect, which is what a Space needs.
                      </p>
                      <div className="setup-cmd">
                        <code className="mono">{c.signIn}</code>
                        <button className="mini-btn" onClick={() => copy(c.signIn!)}>{copied === c.signIn ? 'copied' : 'copy'}</button>
                      </div>
                      <button className="btn-primary setup-go" onClick={() => onStartSession(c.id)}>Open a {c.label} session</button>
                    </div>
                  ) : (
                    <div className="setup-way">
                      <div className="setup-way-head">Sign in with your subscription</div>
                      <p>
                        We have not confirmed a sign-in flow for {c.label} that completes from a
                        terminal on a remote machine, so use an API key below.
                      </p>
                    </div>
                  )}
                  {!!(c.secrets || []).length && (
                    <div className="setup-way">
                      <div className="setup-way-head"><KeyGlyph /> Use an API key</div>
                      <p>
                        Add any one of these as a Space <b>secret</b>:{' '}
                        {(c.secrets || []).map((k, i) => (
                          <span key={k}>{i ? ' / ' : ''}<span className={`mono${have.has(k) ? ' setup-have' : ''}`}>{k}</span></span>
                        ))}
                        {held.length ? <> — already set.</> : null}
                      </p>
                      {settingsUrl && (
                        <a className="btn-primary setup-go" href={settingsUrl} target="_blank" rel="noreferrer">
                          Open Space settings ↗
                        </a>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {settingsUrl && (
        <p className="setup-restart">
          Adding a secret <b>restarts this Space</b>, so the app will reload. Your files, logins and
          history are on the bucket and survive it — come back to this window and the agent will be
          ready.
        </p>
      )}

      <div className="welcome-foot">
        <button className="btn-ghost" onClick={onTour}>What else can it do? →</button>
        <button className="btn-primary" onClick={onClose}>
          {ready.length ? 'Done' : 'Skip for now'}
        </button>
      </div>
    </>
  );
}
