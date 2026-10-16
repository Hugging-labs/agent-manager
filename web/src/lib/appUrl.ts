// The only query parameters the app itself reads. Anything else in the address
// was put there by something in front of the app (a hosting edge, a referrer)
// and may be a credential, so it is never copied into a link the app produces.
// Keep public/sw.js's copy of this list in sync.
export const APP_PARAMS = ['vvdebug', 'touchdebug'] as const;

/** `?…` with only the app's own parameters from `search`, or ''. */
export function appSearch(search: string = location.search): string {
  const from = new URLSearchParams(search);
  const kept = new URLSearchParams();
  for (const key of APP_PARAMS) for (const value of from.getAll(key)) kept.append(key, value);
  const text = kept.toString();
  return text ? `?${text}` : '';
}

/** Same-origin link to this page: path, allowlisted parameters, then `hash`. */
export function appPath(hash = ''): string {
  return location.pathname + appSearch() + hash;
}

/** Absolute form of appPath, for copying or opening outside this frame. */
export function appUrl(hash = ''): string {
  return location.origin + appPath(hash);
}

/** Drop every non-app parameter from the address bar, keeping path and hash. */
export function stripForeignParams(): void {
  const clean = appPath(location.hash);
  if (clean !== location.pathname + location.search + location.hash) {
    history.replaceState(history.state, '', clean);
  }
}
