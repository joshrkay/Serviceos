/**
 * The one durable hidden platform tenant (plan finding D1, U7).
 *
 * `phone_rate_limits.tenant_id`, `leads.tenant_id` and `audit_events.tenant_id`
 * are all `NOT NULL REFERENCES tenants(id)`, and a demo-pool tenant cannot own
 * the visitor's rows because a reset purges it. So migration 317 inserts this
 * tenant at a fixed uuid, flagged `platform = true`, and every tenant lister,
 * sweep, reaper and pool selection excludes it. The uuid is immutable once 317
 * has been applied anywhere: the migration's INSERT names this literal.
 */
export const DEMO_PLATFORM_TENANT_ID = '00000000-0000-4000-8000-00000000d3a0';

/** `tenants.owner_id` is TEXT NOT NULL UNIQUE; this synthetic id never matches a Clerk user. */
export const DEMO_PLATFORM_OWNER_ID = 'platform:demo';

/** Non-deliverable by construction (`.invalid` is reserved, RFC 2606). */
export const DEMO_PLATFORM_OWNER_EMAIL = 'platform-demo@invalid.rivet.local';
