/**
 * Tiny, SSR-safe wrappers around localStorage for lightweight per-browser UI
 * state — "dismissed this banner", "completed the tour", "last release seen".
 *
 * Centralizes the read/write guard the onboarding banners hand-rolled
 * (UpgradeNudgeBanner, ActivationCelebrationBanner) so callers don't repeat
 * the `typeof window === 'undefined'` + try/catch dance. Never throws: a
 * disabled/again full localStorage degrades to "no flag set".
 */

export function getLocalFlag(key: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function setLocalFlag(key: string, value = new Date().toISOString()): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* storage disabled or full — non-fatal for UI-only flags */
  }
}

export function hasLocalFlag(key: string): boolean {
  return getLocalFlag(key) !== null;
}
