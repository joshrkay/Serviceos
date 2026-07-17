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
  | 'landing_signup_clicked'
  // Marketing-site pageviews + app-store CTA. Fired from the standalone
  // marketing pages (features/pricing/about/download) and the store badges.
  | 'view_features'
  | 'view_pricing'
  | 'view_about'
  | 'view_download'
  | 'download_app_clicked'
  // In-app guidance: the new-account first-run tour and the what's-new
  // changelog (components/walkthrough/*).
  | 'tour_started'
  | 'tour_step_viewed'
  | 'tour_completed'
  | 'tour_dismissed'
  | 'announcement_shown'
  | 'announcement_dismissed'
  // Launch funnel (added for the onboarding launch-readiness pass). These
  // are emitted via trackFunnel() so they always carry tenant_id/user_id/
  // timestamp/source. See FUNNEL.md for the trigger + payload of each.
  | 'view_landing'
  | 'signup_started'
  | 'wizard_started'
  | 'wizard_step_business'
  | 'wizard_step_phone'
  | 'wizard_step_voice'
  | 'wizard_step_calendar'
  | 'wizard_completed'
  | 'test_call_initiated'
  | 'test_call_succeeded'
  | 'activation_celebrated'
  // In-app intent/view events (U6). Things the server-side audit stream can't
  // see because there's no row mutation — gestures, not state changes. IDs /
  // enums / counts / bools only, never message or query text.
  | 'assistant_message_sent'
  | 'proposal_viewed'
  | 'customer_search_run'
  // ARCH-31 / OBS-43 — global async-error capture (lib/errorReporter.ts).
  // Payload is always the redacted { name, message, source } shape; never
  // the raw Error object, a stack trace, a request body, or a token.
  | 'app_error';

type Props = Record<string, string | number | boolean | null | undefined>;

interface PostHogLike {
  capture: (event: string, props?: Props) => void;
  identify: (distinctId: string, traits?: Props) => void;
  group: (groupType: string, groupKey: string, props?: Props) => void;
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
        // /feedback/:token, /e/:id, /pay/:id, /book) where the
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

/** Context every launch-funnel event must carry. tenant_id / user_id may be
 * null on pre-auth events (view_landing, signup_started) — PostHog stitches
 * them to a user once identify() fires post-signup. */
export interface FunnelContext {
  tenantId?: string | null;
  userId?: string | null;
}

/**
 * Emit a launch-funnel event with the four required fields the funnel
 * dashboards depend on — tenant_id, user_id, timestamp, source — merged in
 * uniformly so individual call sites can't forget one. Extra event-specific
 * props (e.g. { step }) are spread on top. Off-by-default like track().
 */
export function trackFunnel(
  event: AnalyticsEvent,
  ctx?: FunnelContext,
  extra?: Props,
): void {
  track(event, {
    tenant_id: ctx?.tenantId ?? null,
    user_id: ctx?.userId ?? null,
    timestamp: new Date().toISOString(),
    source: 'web',
    ...extra,
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
 * Bind the current browser session to a tenant group so events roll up per
 * tenant (PostHog group analytics — the primary lever for a multi-tenant B2B
 * product). Call after identify(). Off-by-default and never throws, like the
 * rest of this wrapper.
 *
 * Only the thin tenant traits available client-side (e.g. `timezone` from
 * /api/me) are passed here; the authoritative B2B traits (vertical, plan,
 * subscription_status, activated) are set server-side, where they change and
 * are known even for tenants who never open the web app.
 */
export function groupTenant(tenantId: string, traits?: Props): void {
  void loadPosthog().then((ph) => {
    if (!ph) return;
    try {
      ph.group('tenant', tenantId, traits);
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
