/**
 * Deep-link / universal-link parsing for the Capacitor mobile app.
 *
 * Maps an inbound link — an https universal/App Link, or the `rivet://` custom
 * scheme (used for deep links and the Clerk OAuth return) — to an in-app React
 * Router path. Security: foreign https hosts are rejected so a malicious link
 * can't drive navigation (no open-redirect). Unknown same-origin paths are
 * returned as-is; React Router 404s them gracefully.
 *
 * Pure function. The native `App.appUrlOpen` subscription that feeds URLs in
 * and calls `navigate()` is wired in the native shell (native-phase follow-up).
 */
export interface DeepLinkConfig {
  /** https host(s) treated as our own universal-link domain. */
  allowedHosts: string[];
  /** Custom scheme(s) without the colon, e.g. ['rivet']. */
  schemes: string[];
}

/** Normalize a pathname+search into a clean in-app route. */
function buildRoute(pathname: string, search: string): string {
  // Collapse repeated slashes (defuses '//evil.com' protocol-relative paths).
  let path = pathname.replace(/\/{2,}/g, '/');
  if (!path.startsWith('/')) path = `/${path}`;
  if (path.length > 1) path = path.replace(/\/+$/, ''); // strip trailing slash (not root)
  const clean = path || '/';
  return search ? `${clean}${search}` : clean;
}

/**
 * Parse an inbound deep link to an in-app route path, or null when it isn't
 * one of ours.
 */
export function parseDeepLink(rawUrl: string, config: DeepLinkConfig): string | null {
  if (!rawUrl) return null;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  const scheme = parsed.protocol.replace(/:$/, '').toLowerCase();

  // Custom scheme (rivet://e/123): the URL parser puts the first path segment
  // in `host`, so rebuild the path from host + pathname.
  if (config.schemes.some((s) => s.toLowerCase() === scheme)) {
    return buildRoute(`/${parsed.host}${parsed.pathname}`, parsed.search);
  }

  // Universal / App Links — only our own https host(s).
  if (scheme === 'https' || scheme === 'http') {
    const host = parsed.hostname.toLowerCase();
    if (!config.allowedHosts.some((h) => h.toLowerCase() === host)) return null;
    return buildRoute(parsed.pathname, parsed.search);
  }

  return null;
}
