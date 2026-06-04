/**
 * Thin analytics wrapper around PostHog.
 *
 * Why a wrapper:
 *   - Off-by-default. Without `VITE_POSTHOG_KEY` set, every track() /
 *     identify() / capture() call is a no-op so local dev and preview
 *     deploys without analytics keys behave identically to prod.
 *   - Centralizes the event name registry so funnel queries don't drift
 *     when one component renames an event.
 *   - Loads posthog-js only on first use — saves ~30KB of JS on cold
 *     loads when the key isn't configured (i.e. every environment that
 *     isn't prod).
 *
 * To enable in any environment, set `VITE_POSTHOG_KEY`. Optionally
 * override the ingestion host with `VITE_POSTHOG_HOST` (defaults to
 * the US cloud).
 */

import { getRuntimeConfigValue } from './runtimeConfig';

/**
 * Funnel events tracked across the Rivet app. Adding a new event?
 * Put it here so all surfaces query the same name.
 */
export type AnalyticsEvent =
  | 'signup_completed'
  | 'onboarding_step_viewed'
  | 'onboarding_step_completed'
  | 'onboarding_completed'
  | 'voice_agent_turned_on'
  | 'first_ai_call_detected'
  | 'trial_started'
  | 'pricing_cta_clicked'
  | 'landing_signup_clicked';

type Props = Record<string, string | number | boolean | null | undefined>;

interface PostHogLike {
  capture: (event: string, props?: Props) => void;
  identify: (distinctId: string, traits?: Props) => void;
  reset: () => void;
}

let posthog: PostHogLike | null = null;
let initPromise: Promise<PostHogLike | null> | null = null;
let initialized = false;

function getPosthogKey(): string | undefined {
  return getRuntimeConfigValue('VITE_POSTHOG_KEY');
}

function getPosthogHost(): string {
  return getRuntimeConfigValue('VITE_POSTHOG_HOST') ?? 'https://us.i.posthog.com';
}

async function loadPosthog(): Promise<PostHogLike | null> {
  if (posthog) return posthog;
  if (initPromise) return initPromise;

  const key = getPosthogKey();
  if (!key) {
    initialized = true;
    return null;
  }

  initPromise = (async () => {
    try {
      const mod = await import('posthog-js');
      const ph = mod.default;
      ph.init(key, {
        api_host: getPosthogHost(),
        // We capture explicitly via track() — autocapture would surface
        // proposal/customer/etc names from the dashboard which is PII.
        autocapture: false,
        // PostHog pageviews include the current URL. Public routes in
        // routes.ts use credential-bearing path params (/portal/:token,
        // /public/feedback/:token, /e/:id, /pay/:id, /book) where the
        // path itself is the bearer secret — sending those URLs to a
        // third-party analytics service would leak the credential.
        // Disable autocapture pageviews; the launch funnel is built
        // from the explicit named track() events, not page hits.
        capture_pageview: false,
        disable_session_recording: true,
        persistence: 'localStorage+cookie',
      });
      posthog = ph as unknown as PostHogLike;
      initialized = true;
      return posthog;
    } catch {
      // posthog-js may fail to load on a restrictive CSP or ad-blocker.
      // Stay silent so we never break the app over analytics.
      initialized = true;
      return null;
    }
  })();

  return initPromise;
}

/**
 * Fire-and-forget event. Safe to call before PostHog has loaded — the
 * call queues until init resolves, then drains. Never throws.
 */
export function track(event: AnalyticsEvent, props?: Props): void {
  void loadPosthog().then((ph) => {
    if (!ph) return;
    try {
      ph.capture(event, props);
    } catch {
      // Never let an analytics failure surface.
    }
  });
}

/**
 * Bind PostHog's distinct_id to a stable user identifier (Clerk userId).
 * Once called, all subsequent track() calls in this browser session are
 * attributed to this user. Re-calling with the same id is a no-op.
 */
export function identify(userId: string, traits?: Props): void {
  void loadPosthog().then((ph) => {
    if (!ph) return;
    try {
      ph.identify(userId, traits);
    } catch {
      /* swallow */
    }
  });
}

/**
 * Clear identity on logout so the next user doesn't inherit traits.
 */
export function resetIdentity(): void {
  void loadPosthog().then((ph) => {
    if (!ph) return;
    try {
      ph.reset();
    } catch {
      /* swallow */
    }
  });
}

/**
 * Eagerly initialize at app boot. Optional — track()/identify() will
 * lazy-load on first call. Calling this in main.tsx warms the bundle
 * so the first track() doesn't pay a network round-trip.
 */
export function initAnalytics(): void {
  void loadPosthog();
}

/** True iff a key is configured (used to gate diagnostic logging in dev). */
export function isAnalyticsEnabled(): boolean {
  return Boolean(getPosthogKey());
}

/** Test helper. Resets cached state so unit tests start clean. */
export function __resetAnalyticsForTests(): void {
  posthog = null;
  initPromise = null;
  initialized = false;
}

// Re-exported only to silence the unused-var lint when initialized is
// only inspected by tests via the helper above.
export function __getAnalyticsInitializedForTests(): boolean {
  return initialized;
}
