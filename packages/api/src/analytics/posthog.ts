/**
 * Server-side PostHog wrapper.
 *
 * Two families of events flow through here:
 *
 *   Funnel events (the browser never sees these) — recordFunnelEvent():
 *   - signup_completed    (Clerk user.created → bootstrapTenant)
 *   - trial_started       (Stripe subscription.* with status='trialing')
 *   - trial_to_paid       (Stripe subscription.updated: trialing → active)
 *   - subscription_canceled  (Stripe subscription.deleted)
 *   - first_real_call_received  (voice/activation.ts)
 *
 *   Product events (in-app feature usage) — recordProductEvent(): the curated,
 *   PII-safe names in ./product-events.ts, emitted server-side (primarily by
 *   the audit→product forwarding decorator). Tenant-level analytics ride on
 *   PostHog group analytics — every product event (and any funnel event that
 *   carries a tenant id) is stamped with `groups: { tenant }`, and tenant
 *   group *properties* are set via recordTenantGroup().
 *
 * Off-by-default. Without `POSTHOG_API_KEY` set, every record*() call is a
 * no-op and the SDK is never instantiated, so test / preview / any environment
 * without analytics behaves identically to today.
 *
 * Distinct ids should match the web SDK's identify() call (Clerk userId) so a
 * single user is one stream across browser + server events. The tenantId is
 * passed so PostHog can group by tenant even before the first browser identify
 * fires.
 */

import type { ProductEventName } from './product-events';

export type FunnelEvent =
  | 'signup_completed'
  | 'trial_started'
  | 'trial_to_paid'
  | 'subscription_canceled'
  // Activation milestone — the first real inbound call a tenant's voice
  // agent handles after go-live. Emitted server-side from voice/activation.ts
  // (idempotent once per tenant). See FUNNEL.md for the activation rule.
  | 'first_real_call_received';

/** Props allowed on any server-side event — IDs/enums/flags only, never PII. */
type EventProps = Record<string, string | number | boolean | null | undefined>;

interface FunnelEventPayload {
  /** Stable per-user id — the Clerk userId, matching the browser SDK. */
  distinctId: string;
  event: FunnelEvent;
  /** Best to include at least tenantId so PostHog can group by tenant. */
  properties?: EventProps;
}

/**
 * Payload for a product (feature-usage) event. `tenantId` is required — it is
 * both a property and the PostHog group key. `distinctId` should be the Clerk
 * userId for human-driven events (so it stitches to the browser identify()) or
 * a stable server id for system/automated actors.
 */
export interface ProductEventPayload {
  tenantId: string;
  distinctId: string;
  /** Extra event-specific props — IDs/enums/flags only, never PII. */
  properties?: EventProps;
  /**
   * Dedup key. When forwarding from the audit stream, pass the audit event id;
   * PostHog dedupes retried/duplicated ingests on `$insert_id`.
   */
  insertId?: string;
}

interface PosthogClientLike {
  capture: (input: {
    distinctId: string;
    event: string;
    properties?: Record<string, unknown>;
    groups?: Record<string, string>;
  }) => void;
  groupIdentify: (input: {
    groupType: string;
    groupKey: string;
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
 * Internal single capture path shared by funnel + product events. Always
 * swallows errors so an analytics failure can never break a billing, auth,
 * or mutation path.
 */
function captureServer(input: {
  distinctId: string;
  event: string;
  properties?: Record<string, unknown>;
  groups?: Record<string, string>;
}): void {
  const ph = getClient();
  if (!ph) return;
  try {
    ph.capture(input);
  } catch {
    // never throw
  }
}

/** Pull a non-empty tenant id out of a funnel event's loosely-typed props. */
function tenantIdFromProps(properties?: EventProps): string | undefined {
  const raw = properties?.tenant_id ?? properties?.tenantId;
  return typeof raw === 'string' && raw !== '' ? raw : undefined;
}

/**
 * Fire-and-forget funnel event. Always swallows errors so an analytics
 * failure can never break a billing or auth webhook. Additively stamps
 * `groups: { tenant }` when the payload carries a tenant id, so funnel events
 * roll up per tenant alongside product events (the event name + shape are
 * otherwise unchanged — dashboards keyed on these names are unaffected).
 */
export function recordFunnelEvent(payload: FunnelEventPayload): void {
  const tenantId = tenantIdFromProps(payload.properties);
  captureServer({
    distinctId: payload.distinctId,
    event: payload.event,
    properties: payload.properties,
    ...(tenantId ? { groups: { tenant: tenantId } } : {}),
  });
}

/**
 * Fire-and-forget product (feature-usage) event. Off-by-default and never
 * throws. Always sets `groups: { tenant }`, merges the standard
 * `{ tenant_id, source, timestamp }` context, and forwards `$insert_id` for
 * dedup when an id is supplied.
 */
export function recordProductEvent(event: ProductEventName, payload: ProductEventPayload): void {
  const properties: Record<string, unknown> = {
    tenant_id: payload.tenantId,
    source: 'server',
    timestamp: new Date().toISOString(),
    ...payload.properties,
  };
  if (payload.insertId) {
    properties.$insert_id = payload.insertId;
  }
  captureServer({
    distinctId: payload.distinctId,
    event,
    properties,
    groups: { tenant: payload.tenantId },
  });
}

/**
 * Set properties on a tenant group (PostHog group analytics). Off-by-default
 * and never throws. Called at the server moments a tenant's traits become
 * known/change (bootstrap, subscription, activation) so tenant-level insights
 * can break down by vertical / plan / subscription_status without every event
 * carrying those props.
 */
export function recordTenantGroup(tenantId: string, traits?: EventProps): void {
  const ph = getClient();
  if (!ph) return;
  try {
    ph.groupIdentify({
      groupType: 'tenant',
      groupKey: tenantId,
      properties: traits,
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

/**
 * Test-only seam: inject a fake client so tests can assert capture /
 * groupIdentify calls without the real SDK (the dynamic require() in
 * getClient() is awkward to mock). Passing null + a set key still lets the
 * real lazy-init run.
 */
export function __setClientForTests(fake: PosthogClientLike | null): void {
  client = fake;
  initialized = true;
}

/** True iff a key is configured. Useful for dev logging gates. */
export function isFunnelAnalyticsEnabled(): boolean {
  return Boolean(getApiKey());
}

/**
 * True iff product analytics is enabled (same key gate as the funnel events).
 * The audit→product forwarding decorator checks this for a fast exit so it
 * skips the mapping work entirely when analytics is off.
 */
export function isProductAnalyticsEnabled(): boolean {
  return Boolean(getApiKey());
}
