import type { Cli } from '../types';
import { KeyGlyph, LockGlyph, PlusGlyph } from './icons';
import StateLogo from './StateLogo';

// First-run SETUP: which agents can actually run, and the least a person has to
// do to make one answer them. The tour next door explains what the product is.
//
// Everything is live. `ready` is the same signal behind the mark in the sidebar
// and Settings (isConfigured in server/src/config.js); `secrets` and `signIn`
// come from the same catalog, so this cannot drift from what the app will do.
//
// The rule for every line here is that a reader can carry it out from where the
// button leaves them. An earlier draft said "open a session and run `claude
// auth login` in the pane" — but a Claude session's pane runs Claude, so that
// text would have gone to the model as a prompt. Each agent below says only
// what opening its session actually requires, which for the two that work is
// nothing, or one choice.

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
  const agents = setupCandidates(clis);
  const ready = agents.filter((c) => c.ready);
  const have = new Set(presentSecrets);
  // The Space's own settings page, built rather than described.
  const settingsUrl = spaceId ? `https://huggingface.co/spaces/${spaceId}/settings` : null;
  const anySignIn = agents.some((c) => !c.ready && c.signIn);
  const anyKeyOnly = agents.some((c) => !c.ready && !c.signIn && c.secrets?.length);

  return (
    <>
      <div className="welcome-head">
        <span className="welcome-mark"><PlusGlyph /></span>
        <div>
          <h2 id="welcome-title">Connect your first agent</h2>
          <p>
            {ready.length
              ? <><b>{ready.length} of {agents.length}</b> ready. Start one, or set up another below.</>
              : <>Nothing is signed in yet. Pick an agent — whichever route you use, it persists across restarts.</>}
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

      {/* Said once, not once per agent. */}
      {(anySignIn || anyKeyOnly) && (
        <div className="setup-how">
          {anySignIn && (
            <p>
              <b>Open a session</b> and the agent walks you through signing in — it shows a link to
              open and a code to bring back, because a Space has no browser of its own.
            </p>
          )}
          {anyKeyOnly && settingsUrl && (
            <p>
              <b>Or use an API key.</b> Add it as a Space <b>secret</b>; that <b>restarts the
              Space</b>, and your files, logins and history are on the bucket and survive it.
            </p>
          )}
        </div>
      )}

      <div className="setup-list">
        {agents.map((c) => {
          const held = (c.secrets || []).filter((k) => have.has(k));
          return (
            <div key={c.id} className={`setup-row${c.ready ? ' ok' : ''}`}>
              <span className="setup-logo">
                {/* One mark for both questions: which agent, and is it ready.
                    Same vocabulary as the sidebar — a live frame for an agent
                    that can run, the off frame for one that cannot yet. */}
                <StateLogo cli={c.id} state={c.ready ? 'idle' : 'stopped'} size={16} tint={c.color} />
              </span>
              <span className="setup-name">{c.label}</span>
              <span className="setup-state mono">{c.ready ? 'ready' : 'needs setup'}</span>
              <div className="setup-act">
                {c.ready ? (
                  <>
                    <span className="setup-note">
                      {held.length ? <>via the <span className="mono">{held[0]}</span> secret</> : <>signed in</>}
                    </span>
                    <button className="btn-primary setup-go" onClick={() => onStartSession(c.id)}>Start a session</button>
                  </>
                ) : c.signIn ? (
                  <>
                    {/* Every row is a line of text and an action, so the note is
                        not optional: `note` carries the one thing a particular
                        pane does not make obvious, and otherwise this says what
                        the session will do. Without it an agent that needs no
                        caveat — Claude — had a button alone on the left. */}
                    <span className="setup-note">
                      {c.signIn.note
                        || <>Sign in when the session opens — it shows a link, and a code to paste back.</>}
                    </span>
                    <button className="btn-primary setup-go" onClick={() => onStartSession(c.id)}>
                      Open a {c.label} session
                    </button>
                  </>
                ) : (
                  <>
                    <span className="setup-note">
                      <KeyGlyph /> Needs a key:{' '}
                      {(c.secrets || []).map((k, i) => (
                        <span key={k}>{i ? ' / ' : ''}<span className={`mono${have.has(k) ? ' setup-have' : ''}`}>{k}</span></span>
                      ))}
                    </span>
                    {settingsUrl && (
                      <a className="btn-ghost setup-go" href={settingsUrl} target="_blank" rel="noreferrer">
                        Add a secret ↗
                      </a>
                    )}
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="welcome-foot">
        <button className="btn-ghost" onClick={onTour}>What else can it do? →</button>
        <button className="btn-primary" onClick={onClose}>{ready.length ? 'Done' : 'Skip for now'}</button>
      </div>
    </>
  );
}
