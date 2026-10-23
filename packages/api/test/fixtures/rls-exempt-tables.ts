/**
 * The reviewed list of tables that carry a `tenant_id` column but are
 * deliberately NOT under row-level security.
 *
 * One list, shared by every test that needs it:
 *   - test/db/schema.test.ts — "every tenant_id table FORCEs RLS, except these"
 *     and the pin that stops this set from growing silently;
 *   - test/invariants/raw-pool-rls.structural.test.ts — a `global_table`
 *     allowlist entry may name a tenant_id table only if it is listed here.
 *
 * Adding a table here is a security decision: document the reason here AND in
 * its migration block in src/db/schema.ts.
 */
export const RLS_EXEMPT_TABLES_SHARED: ReadonlySet<string> = new Set<string>([
  // oauth_states: short-lived Google OAuth state nonces. The /callback
  // path calls consume(stateId) BEFORE tenant context is set —
  // recovering tenant_id from the row IS the lookup. RLS would make the
  // row invisible to the call that needs it.
  'oauth_states',
  // platform_deprovision_log: cross-tenant audit trail of tenant
  // hard-deletes. By design, this row outlives the tenant it records.
  'platform_deprovision_log',
  // U7 demo call (migration 317): platform tables whose tenant_id only
  // NAMES the demo tenant a call, a running job or a signup holds. They are
  // read by the reaper, the reset and the queue front door with no tenant
  // context (the lease is how the tenant is discovered), so an
  // app.current_tenant_id policy would hide every row from the code that
  // needs it. The runtime role is revoked on them (219 and 317).
  'demo_tenant_leases',
  'demo_inflight_jobs',
  'signup_handoffs',
]);
