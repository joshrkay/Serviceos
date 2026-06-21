/**
 * App-store destinations for the Rivet mobile app (packages/mobile).
 *
 * These are read from runtime env so the live store URLs can be set at
 * deploy time without a rebuild. Until the listings are published they
 * fall back to the marketing /download page (never a dead `#` link).
 *
 * TODO(launch): set VITE_APP_STORE_URL / VITE_PLAY_STORE_URL once the
 * App Store and Google Play listings are live. See
 * packages/mobile/store/*.md for the listing copy.
 */
import { getRuntimeConfigValue } from '../../lib/runtimeConfig';

/** Where "Download" / store badges point until the real listings exist. */
const FALLBACK = '/download';

export function appStoreUrl(): string {
  // `||` (not `??`) so an empty/whitespace value also falls back, even though
  // getRuntimeConfigValue already normalizes empty strings to undefined.
  return getRuntimeConfigValue('VITE_APP_STORE_URL') || FALLBACK;
}

export function playStoreUrl(): string {
  return getRuntimeConfigValue('VITE_PLAY_STORE_URL') || FALLBACK;
}

/** True once at least one real store URL is configured. */
export function hasLiveStoreLinks(): boolean {
  return (
    !!getRuntimeConfigValue('VITE_APP_STORE_URL') ||
    !!getRuntimeConfigValue('VITE_PLAY_STORE_URL')
  );
}
