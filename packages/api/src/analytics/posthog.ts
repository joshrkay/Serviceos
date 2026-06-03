/**
 * Server-side PostHog wrapper for funnel events the browser never sees:
 *
 *   - signup_completed    (Clerk user.created → bootstrapTenant)
 *   - trial_started       (Stripe subscription.* with status='trialing')
 *   - trial_to_paid       (Stripe subscription.updated: trialing → active)
 *   - subscription_canceled  (Stripe subscription.deleted)
 *
 * Off-by-default. Without `POSTHOG_API_KEY` set, every recordFunnelEvent()
 * call is a no-op and the SDK is never instantiated, so test / preview /
 * any environment without analytics behaves identically to today.
 *
 * Distinct ids should match the web SDK's identify() call (Clerk userId)
 * so a single user is one funnel across browser + server events. The
 * tenantId is passed in `properties` so PostHog can group by tenant
 * even before the first browser identify fires.
 */

export type FunnelEvent =
  | 'signup_completed'
  | 'trial_started'
  | 'trial_to_paid'
  | 'subscription_canceled';

interface FunnelEventPayload {
  /** Stable per-user id — the Clerk userId, matching the browser SDK. */
  distinctId: string;
  event: FunnelEvent;
  /** Best to include at least tenantId so PostHog can group by tenant. */
  properties?: Record<string, string | number | boolean | null | undefined>;
}

interface PosthogClientLike {
  capture: (input: {
    distinctId: string;
    event: string;
    properties?: Record<string, unknown>;
  }) => void;
  shutdown: () => Promise<void>;
}

let client: PosthogClientLike | null = null;
let initialized = false;

function getApiKey(): string | undefined {
  const raw = process.env.POSTHOG_API_KEY;
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

function getHost(): string {
  return process.env.POSTHOG_HOST?.trim() || 'https://us.i.posthog.com';
}

/**
 * Lazy-init the PostHog node client. Returns null when no key is
 * configured — every caller is expected to no-op silently in that case.
 */
function getClient(): PosthogClientLike | null {
  if (initialized) return client;
  initialized = true;
  const key = getApiKey();
  if (!key) return null;
  try {
    // Dynamic require keeps posthog-node out of the bundle when the key
    // isn't configured (and out of test paths that don't touch it).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { PostHog } = require('posthog-node') as typeof import('posthog-node');
    client = new PostHog(key, { host: getHost() }) as unknown as PosthogClientLike;
    return client;
  } catch {
    // posthog-node failed to load — never let analytics break the API.
    return null;
  }
}

/**
 * Fire-and-forget event. Always swallows errors so an analytics failure
 * can never break a billing or auth webhook.
 */
export function recordFunnelEvent(payload: FunnelEventPayload): void {
  const ph = getClient();
  if (!ph) return;
  try {
    ph.capture({
      distinctId: payload.distinctId,
      event: payload.event,
      properties: payload.properties,
    });
  } catch {
    // never throw
  }
}

/**
 * Flush queued events on graceful shutdown. Called from the API
 * process's SIGTERM / SIGINT handler so deploys don't drop in-flight
 * funnel events.
 */
export async function shutdownAnalytics(): Promise<void> {
  if (!client) return;
  try {
    await client.shutdown();
  } catch {
    // swallow
  } finally {
    client = null;
    initialized = false;
  }
}

/** Test-only reset for repos that mock the module. */
export function __resetAnalyticsForTests(): void {
  client = null;
  initialized = false;
}

/** True iff a key is configured. Useful for dev logging gates. */
export function isFunnelAnalyticsEnabled(): boolean {
  return Boolean(getApiKey());
}
