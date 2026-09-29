/**
 * #1481 — a lazily-loaded route chunk that can't be fetched (offline hard
 * navigation to a page the service worker hasn't cached, or a stale tab
 * after a redeploy) throws a TypeError such as "Failed to fetch dynamically
 * imported module". That is not an application crash: show the user what
 * actually happened instead of the generic error fallback.
 */
const CHUNK_LOAD_PATTERNS = [
  /Failed to fetch dynamically imported module/i, // Chromium
  /error loading dynamically imported module/i, // Firefox
  /Importing a module script failed/i, // Safari
  /Unable to preload CSS/i, // Vite CSS preload
];

export function isChunkLoadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return CHUNK_LOAD_PATTERNS.some((re) => re.test(error.message));
}

export interface LoadFailureCopy {
  title: string;
  detail: string;
}

/** User-facing copy for a chunk-load failure, or null for any other error. */
export function chunkLoadFailureCopy(error: unknown): LoadFailureCopy | null {
  if (!isChunkLoadError(error)) return null;
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
  return offline
    ? {
        title: "You're offline",
        detail: "This page isn't available offline yet. Reconnect, then tap Try again.",
      }
    : {
        title: "This page couldn't load",
        detail: 'A newer version of the app may be available. Tap Try again to reload.',
      };
}
