import { ApiError } from './api-errors.js';
import { codexBindings, contextError } from './codex-context.js';
import { validThreadId } from './codex-bindings.js';

// Host policy, not endpoint liveness: an unavailable daemon must never turn a
// shared installation back into an independent writer. Socket configuration
// alone is also used by standalone observation-only installations.
export const sharedCodexMode = () => process.env.AM_CODEX_BINDINGS_PILOT === '1'
  || process.env.AM_CODEX_SHARED_CREATE === '1';

export function codexLaunchBlock(session, bindings = codexBindings) {
  if (session.cli !== 'codex') return null;
  let binding;
  try { binding = bindings.forSession(session.id); } catch (e) { throw contextError(e); }
  if (binding || (!sharedCodexMode() && !session.codexSharedOnly)) return null;
  const threadId = validThreadId(session.codexSessionId) ? session.codexSessionId : null;
  const url = `/api/sessions/${encodeURIComponent(session.id)}/codex/migration`;
  return {
    state: 'migration-required', code: 'codex-migration-required', threadId,
    previewUrl: threadId ? url : null, applyUrl: threadId ? url : null,
    message: threadId
      ? `This Codex session must be migrated to the shared server using its existing thread ${threadId}. Review GET ${url}, then apply that preview with POST ${url}. No terminal was started and no prompt was queued.`
      : 'This Codex session has no verified thread ID. Identify its existing conversation before migrating it to the shared server. No terminal was started and no prompt was queued.',
  };
}

export function assertCodexLaunchAllowed(session, bindings = codexBindings) {
  const block = codexLaunchBlock(session, bindings);
  if (block) throw new ApiError(409, block.code, block.message, {
    reason: block.state,
    details: [{ field: 'codexSessionId', message: block.threadId || 'Existing thread identity required' },
      ...(block.previewUrl ? [{ field: 'migrationPreview', message: block.previewUrl }, { field: 'migrationApply', message: block.applyUrl }] : [])],
  });
}

export function assertLegacyCodexCreationAllowed(cli) {
  if (cli === 'codex' && sharedCodexMode()) throw new ApiError(409, 'codex-shared-create-required',
    'This host uses shared Codex. Create new tasks through the shared creation API; scheduled creation of a standalone Codex terminal is disabled.');
}
