// Deploy upstream's TREE as one commit, instead of pushing its history.
//
// The updater used to clone the GitHub repo and `git push --force` it onto the
// Space's `main`. That stopped working the moment any commit anywhere in that
// history added a plain-git binary: HF's pre-receive hook scans every commit in
// the pushed range, and #154 added `docs/images/agent-manager.png` as an
// ordinary blob. #178 moved it to LFS, which fixes the working tree but not the
// history — the old commit is still in the range, so every Space is now stuck
// on "Request failed".
//
// Pushing one commit whose tree IS upstream's tree, parented on what the Space
// already has, puts exactly the same files in place with nothing historical in
// the range. It is also a fast-forward, so `--force` is no longer needed.
//
// LFS objects are a separate transfer and git only sends them from a pre-push
// hook, which a bare `git push` of a ref we built ourselves does not run. So
// they go first and explicitly: a tree full of pointers whose objects never
// arrived is a Space that builds against unreadable files.

/** Recorded in the deploy commit so `check` can tell what is deployed. */
export const UPSTREAM_MARKER = 'Upstream-Commit:';
const MARKER = new RegExp(`^${UPSTREAM_MARKER}\\s*([0-9a-f]{7,40})\\s*$`, 'm');

/** The upstream commit a deploy message names, or null for anything else. */
export function upstreamShaFromMessage(message) {
  return MARKER.exec(String(message || ''))?.[1] || null;
}

export function deployMessage(sha, branch) {
  return `Deploy upstream ${branch} as one commit\n\n`
    + `The files are upstream's tree verbatim. History is not copied, because a\n`
    + `single plain-git binary anywhere in it makes the whole push unacceptable.\n\n`
    + `${UPSTREAM_MARKER} ${sha}\n`;
}

/**
 * Is `latestSha` something this Space is not already running?
 *
 * `deployed` is the upstream commit the last tree deploy recorded; when there
 * is one it is the only honest comparison, because the Space's own HEAD sha is
 * its own and never equals upstream's again. Without one, the Space was
 * force-pushed upstream's history and its sha IS upstream's. Short forms are
 * allowed on either side so an abbreviated marker still matches.
 */
export function isBehind({ deployed, ownSha, latestSha }) {
  if (!latestSha) return false;
  if (deployed) return !latestSha.startsWith(deployed) && !deployed.startsWith(latestSha);
  return !!ownSha && ownSha !== latestSha;
}

const fail = (reason, detail) => ({ ok: false, reason, detail: detail ? String(detail).slice(0, 600) : undefined });

/**
 * @param git  (args, cwd) => Promise<string>, rejecting with a token-scrubbed
 *             Error. Injected so the caller owns scrubbing, and so a test can
 *             watch the order of operations.
 */
export async function deployUpstreamTree({ sourceUrl, branch = 'main', ownUrl, dir, git }) {
  const one = (text) => String(text || '').trim();
  try {
    await git(['clone', '--quiet', '--branch', branch, '--single-branch', sourceUrl, dir]);
  } catch (error) { return fail('upstream-unreachable', error.message); }

  let upstream;
  let tree;
  try {
    upstream = one(await git(['rev-parse', 'HEAD'], dir));
    tree = one(await git(['rev-parse', 'HEAD^{tree}'], dir));
  } catch (error) { return fail('upstream-unreadable', error.message); }

  try {
    await git(['remote', 'add', 'own', ownUrl], dir);
  } catch (error) { return fail('own-remote-failed', error.message); }

  // A Space whose `main` is empty or unreachable is not an error yet: with no
  // parent the deploy is simply the first commit. Anything else that goes wrong
  // here surfaces when the push is refused, with git's own words.
  let parent = null;
  try {
    await git(['fetch', '--quiet', 'own', branch], dir);
    parent = one(await git(['rev-parse', 'FETCH_HEAD'], dir)) || null;
  } catch { parent = null; }

  if (parent) {
    try {
      if (one(await git(['rev-parse', `${parent}^{tree}`], dir)) === tree) {
        return { ok: true, upToDate: true, from: parent, to: upstream };
      }
    } catch (error) { return fail('own-unreadable', error.message); }
  }

  let commit;
  try {
    commit = one(await git(['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', deployMessage(upstream, branch)], dir));
  } catch (error) { return fail('commit-failed', error.message); }

  // Refuse to push something that is not what we meant to push. An empty
  // deploy would also be a lie in the Space's history.
  try {
    if (one(await git(['rev-parse', `${commit}^{tree}`], dir)) !== tree) return fail('tree-mismatch', commit);
  } catch (error) { return fail('commit-unreadable', error.message); }
  if (!commit || commit === parent) return fail('empty-deploy');

  const ref = 'refs/heads/am-deploy';
  try {
    await git(['update-ref', ref, commit], dir);
  } catch (error) { return fail('ref-failed', error.message); }

  // Only when the tree actually carries pointers: on a repo with no LFS files
  // this is a no-op worth skipping rather than a transfer worth failing on.
  let pointers = '';
  try { pointers = one(await git(['lfs', 'ls-files', '-n', commit], dir)); } catch { pointers = ''; }
  if (pointers) {
    try {
      await git(['lfs', 'push', 'own', ref], dir);
    } catch (error) { return fail('lfs-push-failed', error.message); }
  }

  try {
    await git(['push', 'own', `${ref}:refs/heads/${branch}`], dir);
  } catch (error) { return fail('push-rejected', error.message); }

  return { ok: true, from: parent, to: upstream, commit, lfs: !!pointers };
}
