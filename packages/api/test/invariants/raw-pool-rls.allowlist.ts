/**
 * Reviewed raw `pg` access sites (raw-pg audit 2026-10-23, §3.4).
 *
 * Every entry is a place where SQL runs WITHOUT the RLS runtime role that
 * `applyTenantContext` sets, or where a checkout / GUC is hand-rolled — a
 * checkout itself, every call to a raw-checkout helper (its callback runs on
 * the helper's principal client), a Pool escaping into a structural type — and
 * the reason it is acceptable today. Keyed by (file, fn, access) with an EXACT
 * count: line numbers move on every edit, a function name plus a count stays
 * stable and still catches a new statement. Checkouts and helper calls also
 * name, exactly, every function they hand the client to (`handsOffTo`). See
 * docs/solutions/architecture-patterns/raw-pg-rls-structural-guard.md.
 */

export const RAW_PG_CATEGORIES = [
  /** Touches only tables with no RLS (or no tables at all: locks, LISTEN, health). */
  'global_table',
  /** Runs before any tenant is known; the lookup is how the tenant is found. */
  'pre_tenant_lookup',
  /** Spans tenants on purpose (a sweep, a purge). */
  'cross_tenant_intentional',
  /** The client this runs on already carries applyTenantContext (R-order checks checkouts). */
  'tenant_context_applied',
  /** Tenant-scoped SQL on an RLS table as the principal: the WHERE clause is the only boundary. Debt. */
  'tenant_filtered_no_rls',
  /** A write pinned to a platform constant tenant (the demo platform) that cannot take the runtime role. */
  'platform_constant_exception',
] as const;
export type RawPgCategory = (typeof RAW_PG_CATEGORIES)[number];

export const RAW_PG_ACCESS_KINDS = [
  'pool.query',
  'pool.connect',
  'ambient-or-pool',
  'client.connect',
  'withClient',
  /** A call to a raw-checkout helper (the callback runs on the helper's principal client), or a pool.on listener. */
  'checkout-callback',
  /** A Pool passed into a structurally typed parameter (or cast) whose `.query` the typed rule cannot classify. */
  'pool-escape',
  'guc-only',
] as const;
export type RawPgAccess = (typeof RAW_PG_ACCESS_KINDS)[number];

export interface RawPgSite {
  /** src-relative path, e.g. 'src/voice/voice-gate.ts'. */
  readonly file: string;
  /** Nearest named function as the scanner names it: `Class.method`, `fn`, `obj.method`, `POST /route`. */
  readonly fn: string;
  readonly access: RawPgAccess;
  /** Exact number of such accesses in the function. */
  readonly count: number;
  readonly category: RawPgCategory;
  /** Tables the function's SQL touches. The guard checks the SQL against this list. */
  readonly tables: readonly string[];
  /**
   * The SQL's tables cannot be read statically: it names a table through a
   * template substitution (`FROM "<table>"`), or its text is not a literal (a
   * caller-supplied `sql`, a string a function builds). `tables` is then by
   * review, and the why must say the SQL is dynamic.
   */
  readonly dynamicSql?: true;
  /** Why this is acceptable today (>= 40 chars). */
  readonly why: string;
  /** The audit item (or issue) that removes this entry. Required for tenant_filtered_no_rls. */
  readonly migrateBy?: string;
  /**
   * Checkouts and helper calls: every function (by the callee's text, e.g.
   * `watchSessionLease`, `this.ensureTable`) the client is handed to, where
   * each such function hands it on (`runSteps > tryConsumeOn`), and any other
   * escape (`<alias x>`, `<object>`, `<return>`, `<closure>` for a function
   * over the client that is passed, returned or stored, `callback <text>`).
   * Exact: a new handoff and a stale one both fail.
   */
  readonly handsOffTo?: readonly string[];
}

/**
 * The context helpers themselves, keyed like an entry: (file, fn, access)
 * with an exact count, so a second raw function in their file is unlisted.
 * Exempt from the tables/category checks (they ARE the scoping), not from
 * the unlisted, count, stale or handoff rules.
 */
export interface SanctionedHelper {
  readonly file: string;
  readonly fn: string;
  readonly access: RawPgAccess;
  readonly count: number;
  readonly why: string;
  /** A checkout that must hand the client to a context helper before its first query. */
  readonly contextFirst?: true;
  readonly handsOffTo?: readonly string[];
}

export const SANCTIONED_HELPERS: readonly SanctionedHelper[] = [
  {
    file: 'src/db/migrate.ts', fn: 'runMigrations', access: 'pool.connect', count: 1,
    handsOffTo: [
      'runMigrationsOnClient', 'runMigrationsOnClient > <closure>', 'runMigrationsOnClient > applyMigrations',
      'runMigrationsOnClient > withMigrationAdvisoryLock', 'verifyCriticalConstraints',
      'verifyCriticalConstraints > findMissingCriticalConstraints',
    ],
    why: 'The migrator runs DDL as the privileged owner by design (it creates the roles and the policies) on a direct-pool client handed to runMigrationsOnClient (withMigrationAdvisoryLock(client, () => applyMigrations(client))) and, on the duplicate-policy recovery path, verifyCriticalConstraints (its findMissingCriticalConstraints catalog read). It never reads tenant rows.',
  },
  {
    file: 'src/db/pg-base.ts', fn: 'PgBaseRepository.withTenantTransaction', access: 'pool.connect', count: 1,
    contextFirst: true, handsOffTo: ['clearTenantContext'],
    why: 'The repository tenant transaction: BEGIN + applyTenantContext before fn(client); clearTenantContext resets the role and GUC before release.',
  },
  {
    file: 'src/db/pg-base.ts', fn: 'PgBaseRepository.withClient', access: 'pool.connect', count: 1,
    why: 'The raw principal checkout behind every withClient call. It is a raw-checkout helper, so each CALL is a listed withClient entry with its callback SQL, not this.',
  },
  {
    file: 'src/db/pg-base.ts', fn: 'PgBaseRepository.withCrossTenantSweep', access: 'pool.connect', count: 1,
    contextFirst: true, handsOffTo: ['clearTenantContext'],
    why: 'The attributed cross-tenant sweep: BEGIN + applyCrossTenantRole (rls_cross_tenant) before fn(client); clearTenantContext resets the role before release.',
  },
  {
    file: 'src/db/rls-runtime-role.ts', fn: 'applyTenantContext', access: 'guc-only', count: 1,
    why: "applyTenantContext's transactional set_config('app.current_tenant_id', $1, true), followed by SET LOCAL ROLE rls_app_runtime: the context helper itself.",
  },
  {
    file: 'src/db/rls-runtime-role.ts', fn: 'withTenantSession', access: 'pool.connect', count: 1,
    contextFirst: true,
    why: 'Off-request tenant session: BEGIN + applyTenantContext before fn(client), COMMIT/ROLLBACK, release.',
  },
  {
    file: 'src/db/rls-runtime-role.ts', fn: 'verifyRlsRuntimeRole', access: 'pool.connect', count: 1,
    handsOffTo: ['probeRoleAssumable'],
    why: 'Boot probe: probeRoleAssumable runs SET ROLE / RESET ROLE for the two runtime roles on one client. No table is read.',
  },
  {
    file: 'src/db/schema.ts', fn: 'setTenantContext', access: 'guc-only', count: 1,
    why: "Builds the session-level SET app.current_tenant_id that applyTenantContext's non-transactional path runs (it validates the UUID first); the RLS policies themselves live here.",
  },
  {
    file: 'src/db/tenant-transaction.ts', fn: 'withTenantConnection', access: 'pool.connect', count: 1,
    contextFirst: true,
    why: 'withTenantConnection / withTenantClient: BEGIN + applyTenantContext before fn(client) — the tenant-scoped transaction route and worker code are told to use.',
  },
  {
    file: 'src/db/tenant-transaction.ts', fn: 'PgTenantTransactionRunner.run', access: 'pool.connect', count: 1,
    contextFirst: true, handsOffTo: ['<closure>', '<object>'],
    why: "The savepoint/advisory-lock unit of work: BEGIN + applyTenantContext, then the client goes into the TenantContext object published to tenantContextStore for the repositories inside fn, and the TransactionScope's lock/savepoint closures run their SQL on it inside fn.",
  },
  {
    file: 'src/middleware/tenant-context.ts', fn: 'withTenantTransaction', access: 'pool.connect', count: 1,
    contextFirst: true, handsOffTo: ['<closure>', '<object>'],
    why: "The /api request middleware: checks out the request client, BEGIN + applyTenantContext, then publishes it in the TenantContext object to tenantContextStore; the COMMIT/ROLLBACK + release closures (cleanup, releaseOnce) run from res.end and the response's finish/close listeners. The same file also holds a listed pre-tenant lookup.",
  },
  {
    file: 'src/workers/tenant-query.ts', fn: 'tenantQuery', access: 'pool.connect', count: 1,
    contextFirst: true,
    why: 'tenantQuery: one statement per BEGIN + applyTenantContext transaction for background workers; callers supply their own tenant predicate.',
  },
];

/** Tables a site names that no migration creates (so the census cannot see them). */
export const TABLES_WITHOUT_MIGRATION: ReadonlyArray<{ readonly table: string; readonly why: string }> = [
  {
    table: 'platform_admins',
    why: 'Audit F9: the original 046_create_platform_admins migration is gone, so no migration creates it; requirePlatformAdmin fails closed (503) on a fresh database. Tracked as §4 P4.3.',
  },
];

/**
 * The `tenant_filtered_no_rls` debt, frozen. Migrating one means deleting its
 * entry and LOWERING this number; adding one means raising it, in review.
 */
export const TFNR_CEILING = 39;

export const RAW_PG_SITES: readonly RawPgSite[] = [
  // ── ai/ ────────────────────────────────────────────────────────────────
  {
    file: 'src/ai/training/knowledge-chunks.ts', fn: 'PgKnowledgeChunkRepository.insert', access: 'withClient', count: 1,
    category: 'platform_constant_exception', tables: ['knowledge_chunks'],
    why: "withClient is only the scope='global' branch (tenantId null; tenant rows go through withTenantTransaction). It writes the platform-owned global RAG tier where tenant_id is the constant NULL (validateInput + the table CHECK); ON CONFLICT includes tenant_id NULLS NOT DISTINCT (migration 351), so DO UPDATE can only touch another global row.",
  },

  // ── app.ts ─────────────────────────────────────────────────────────────
  {
    file: 'src/app.ts', fn: 'createApp.check', access: 'pool.query', count: 1,
    category: 'global_table', tables: [],
    why: "The 'database' health check: SELECT 1 liveness probe for /ready and /health. Reads no table and carries no tenant.",
  },
  {
    file: 'src/app.ts', fn: 'createApp.resolveDisplayName', access: 'pool.query', count: 1,
    category: 'global_table', tables: ['tenants'],
    why: 'Terminal router display name: SELECT name FROM tenants WHERE id = $1 with the req.auth tenant. tenants is the registry (no tenant_id column, no RLS).',
  },
  {
    file: 'src/app.ts', fn: 'userModeService.getUser', access: 'pool.query', count: 1,
    category: 'tenant_filtered_no_rls', tables: ['users'], migrateBy: 'audit 2026-10-23 §4 P2.1',
    why: 'Mode loader read on FORCE-RLS users, run on its own pooled connection outside the request transaction on every requireTenant request (60 s cache). WHERE tenant_id = $1 AND clerk_user_id = $2 with the JWT tenant/user is the only boundary.',
  },
  {
    file: 'src/app.ts', fn: 'userModeService.getTenantSettings', access: 'pool.query', count: 1,
    category: 'tenant_filtered_no_rls', tables: ['tenant_settings'], migrateBy: 'audit 2026-10-23 §4 P2.1',
    why: 'GET /api/me reads tenant_settings (FORCE RLS) on the raw pool, WHERE tenant_id = $1 with auth.tenantId. settingsRepo already has a withTenant path for the same table.',
  },
  {
    file: 'src/app.ts', fn: 'userModeService.getTenantIntegrationStatuses', access: 'pool.query', count: 1,
    category: 'tenant_filtered_no_rls', tables: ['tenant_integrations'], migrateBy: 'audit 2026-10-23 §4 P2.1',
    why: 'GET /api/me lists provider/status from FORCE-RLS tenant_integrations with no GUC at all; it returns rows only because the principal bypasses RLS. Isolation is WHERE tenant_id = $1 (auth tenant).',
  },
  {
    file: 'src/app.ts', fn: 'userModeService.setMode', access: 'pool.query', count: 1,
    category: 'tenant_filtered_no_rls', tables: ['users'], migrateBy: 'audit 2026-10-23 §4 P2.1',
    why: 'POST /api/me/mode UPDATEs users (FORCE RLS) outside the request transaction (it does not roll back with the request). Scoped only by WHERE tenant_id = $3 AND clerk_user_id = $4, both from req.auth.',
  },

  // ── auth/ ──────────────────────────────────────────────────────────────
  {
    file: 'src/auth/authorization-loader.ts', fn: 'createAuthorizationLoader', access: 'pool.query', count: 1,
    category: 'pre_tenant_lookup', tables: ['users'],
    why: "The membership gate itself: runs before the tenant transaction exists, keyed by the verified JWT's tenant_id and Clerk subject, and returns only the caller's own membership row (missing/revoked → 403).",
  },
  {
    file: 'src/auth/pg-tenant.ts', fn: 'PgTenantRepository.findByOwner', access: 'pool.query', count: 1,
    category: 'global_table', tables: ['tenants'],
    why: 'Tenant bootstrap lookup by owner_id (the verified Clerk subject) on the tenants registry, which has no tenant_id column and no RLS.',
  },
  {
    file: 'src/auth/pg-tenant.ts', fn: 'PgTenantRepository.findById', access: 'pool.query', count: 1,
    category: 'global_table', tables: ['tenants'],
    why: "Point read of a tenants registry row by id (no RLS). Public routes use it only as a UUID-validated existence check; owner fields are never echoed.",
  },
  {
    file: 'src/auth/pg-tenant.ts', fn: 'PgTenantRepository.create', access: 'pool.query', count: 1,
    category: 'global_table', tables: ['tenants'],
    why: 'INSERT into the tenants registry during bootstrap, before any tenant exists; owner_id is the verified Clerk user. No tenant_id column, no RLS.',
  },
  {
    file: 'src/auth/pg-tenant.ts', fn: 'PgTenantRepository.setSignupAttribution', access: 'pool.query', count: 1,
    category: 'global_table', tables: ['tenants'],
    why: "Write-once UPDATE of signup attribution on the caller's own new tenants row (bootstrapTenant result). tenants has no RLS.",
  },
  {
    file: 'src/auth/platform-admin.ts', fn: 'PgPlatformAdminChecker.isPlatformAdmin', access: 'pool.connect', count: 1,
    category: 'global_table', tables: ['platform_admins'],
    why: 'requirePlatformAdmin reads platform_admins (no tenant_id, deliberately no RLS) by the verified Clerk user id, and must not set a tenant GUC. Fails closed (503) when the table is absent (audit F9).',
  },
  {
    file: 'src/auth/platform-admin.ts', fn: 'grantPlatformAdmin', access: 'pool.connect', count: 1,
    category: 'global_table', tables: ['platform_admins'],
    why: 'Operator-CLI grant (scripts/grant-platform-admin.ts) into the global platform_admins authority table; no tenant data. Audit F9 tracks the non-atomic audit write.',
  },
  {
    file: 'src/auth/platform-admin.ts', fn: 'revokePlatformAdmin', access: 'pool.connect', count: 1,
    category: 'global_table', tables: ['platform_admins'],
    why: 'Revoke from the global platform_admins table. No caller outside tests (audit §1.3 dead-code candidate, P4.2); no tenant data either way.',
  },
  {
    file: 'src/auth/resolve-owner-email.ts', fn: 'resolveOwnerEmail', access: 'pool.query', count: 1,
    category: 'tenant_filtered_no_rls', tables: ['users', 'tenants'], migrateBy: 'audit 2026-10-23 §4 P2.3',
    why: "Billing checkout/portal email lookup on a second pooled connection as the principal: users WHERE tenant_id = $1 AND clerk_user_id = $2, tenants WHERE id = $1, $1 = req.auth tenant. Should prefer the ambient request client.",
  },

  // ── availability/ ──────────────────────────────────────────────────────
  {
    file: 'src/availability/seed-from-google.ts', fn: 'seedAvailabilityFromGoogle', access: 'ambient-or-pool', count: 1,
    category: 'tenant_filtered_no_rls', tables: ['tenant_settings'], migrateBy: 'audit 2026-10-23 §4 P2.5',
    why: 'Called only from the unauthenticated Google OAuth callback with the raw pool. The tenant is the server-minted, browser-bound OAuth state (F7 fix); UPDATE tenant_settings … WHERE tenant_id = $1 is the only boundary.',
  },

  // ── billing/ ───────────────────────────────────────────────────────────
  {
    file: 'src/billing/call-usage-billing.ts', fn: 'CallUsageBillingService.settlePeriod', access: 'pool.query', count: 1,
    category: 'global_table', tables: ['tenants'],
    why: 'Overage settlement reads stripe_customer_id/owner_id FROM tenants WHERE id = $1 for the settlement input tenant. tenants has no RLS.',
  },
  {
    file: 'src/billing/call-usage-billing.ts', fn: 'CallUsageBillingService.getStripeCustomerId', access: 'pool.query', count: 1,
    category: 'global_table', tables: ['tenants'],
    why: "Reads one tenant's stripe_customer_id from the tenants registry by id (no RLS); the caller then bills that same tenant.",
  },
  {
    file: 'src/billing/stripe-connect.ts', fn: 'StripeConnectService.getAccount', access: 'pool.query', count: 1,
    category: 'global_table', tables: ['tenants'],
    why: 'Reads the Connect account columns of tenants by id (no RLS). Every caller passes an auth-derived or server-derived tenant id; the result drives server-side Stripe calls only.',
  },
  {
    file: 'src/billing/stripe-connect.ts', fn: 'StripeConnectService.setTerminalLocationId', access: 'pool.query', count: 1,
    category: 'global_table', tables: ['tenants'],
    why: 'UPDATE tenants SET stripe_terminal_location_id WHERE id = $1 (req.auth tenant from the terminal route). tenants is the non-RLS registry.',
  },
  {
    file: 'src/billing/stripe-connect.ts', fn: 'StripeConnectService.createOnboardingLink', access: 'pool.query', count: 1,
    category: 'global_table', tables: ['tenants'],
    why: 'Guarded claim UPDATE of the Connect account on tenants by id = req.auth tenant (Connect onboarding POST). No RLS on tenants.',
  },
  {
    file: 'src/billing/stripe-connect.ts', fn: 'StripeConnectService.applyAccountUpdated', access: 'pool.query', count: 1,
    category: 'global_table', tables: ['tenants'],
    why: 'Signature-verified Stripe account.updated: updates connect flags on tenants WHERE stripe_connect_account_id = the event account. tenants has no RLS.',
  },
  {
    file: 'src/billing/stripe-connect.ts', fn: 'StripeConnectService.disconnect', access: 'pool.query', count: 1,
    category: 'global_table', tables: ['tenants'],
    why: 'Clears the Connect columns on tenants WHERE id = req.auth tenant (billing route). Non-RLS registry.',
  },
  {
    file: 'src/billing/subscription.ts', fn: 'BillingService.getSubscription', access: 'pool.query', count: 1,
    category: 'global_table', tables: ['tenants'],
    why: 'Reads the billing columns on tenants for the req.auth tenant. tenants has no tenant_id column and no RLS.',
  },
  {
    file: 'src/billing/subscription.ts', fn: 'BillingService.createTrialCheckoutSession', access: 'pool.connect', count: 1,
    category: 'global_table', tables: ['tenants'],
    why: "The checkout's own transaction: an advisory xact lock keyed by tenant id, then SELECT/UPDATE on tenants only (req.auth tenant). No tenant table is touched, so no tenant context is needed.",
  },
  {
    file: 'src/billing/subscription.ts', fn: 'BillingService.endTrialNow', access: 'pool.query', count: 1,
    category: 'global_table', tables: ['tenants'],
    why: 'SELECT stripe_subscription_id FROM tenants WHERE id = $1 for the req.auth tenant (billing route). Non-RLS registry.',
  },
  {
    file: 'src/billing/subscription.ts', fn: 'BillingService.applySubscriptionEvent', access: 'pool.query', count: 2,
    category: 'global_table', tables: ['tenants'],
    why: 'UPDATE tenants WHERE stripe_customer_id = the signed event customer; reached only from the webhook no-pool fallback (in-memory dev). tenants has no RLS.',
  },
  {
    file: 'src/billing/subscription.ts', fn: 'BillingService.applyInvoicePaymentFailed', access: 'pool.query', count: 1,
    category: 'global_table', tables: ['tenants'],
    why: 'Signature-verified invoice.payment_failed: UPDATE tenants WHERE stripe_customer_id = the event customer (globally unique Stripe ids). Non-RLS registry.',
  },
  {
    file: 'src/billing/subscription.ts', fn: 'BillingService.clearPendingCheckout', access: 'pool.query', count: 2,
    category: 'global_table', tables: ['tenants'],
    why: 'Reads and clears the pending-checkout marker on tenants WHERE id = req.auth tenant (onboarding route). Non-RLS registry.',
  },
  {
    file: 'src/billing/subscription.ts', fn: 'BillingService.getOrCreateStripeCustomer', access: 'pool.query', count: 3,
    category: 'global_table', tables: ['tenants'],
    why: 'Read, compare-and-set (stripe_customer_id IS NULL) and re-read of one tenants row by id for the auth tenant. tenants has no RLS.',
  },
  {
    file: 'src/billing/tenant-billing-state.ts', fn: 'readTenantBillingState', access: 'pool.query', count: 1,
    category: 'global_table', tables: ['tenants'],
    why: 'The /voice gate reads subscription state FROM tenants WHERE id = $1 for the dialled-number tenant. tenants has no RLS.',
  },

  // ── db/ ────────────────────────────────────────────────────────────────
  {
    file: 'src/db/pool.ts', fn: 'guardClientErrors', access: 'checkout-callback', count: 1,
    category: 'global_table', tables: [],
    why: "pool.on('connect') listener on every new pooled client: it only attaches client.on('error') so a backend termination is a catchable error. It runs no SQL.",
  },

  // ── demo/ ──────────────────────────────────────────────────────────────
  {
    file: 'src/demo/hidden-tenant.ts', fn: 'createHiddenTenantCheck', access: 'pool.query', count: 1,
    category: 'global_table', tables: ['tenants'],
    why: 'Boolean (demo OR platform) FROM tenants WHERE id = $1, cached. A Pick<Pool,"query"> helper over the non-RLS tenants registry.',
  },
  {
    file: 'src/demo/platform-audit.ts', fn: 'setPlatformTenantContext', access: 'guc-only', count: 1,
    category: 'platform_constant_exception', tables: ['audit_events'],
    why: 'Sets app.current_tenant_id to the constant DEMO_PLATFORM_TENANT_ID with deliberately no SET ROLE: the runtime role has no grant on the platform lease table the same transaction writes. Every tenant-table write under it is pinned to that constant.',
  },
  {
    file: 'src/demo/reset.ts', fn: 'inPlatformTransaction', access: 'pool.connect', count: 1,
    category: 'global_table', tables: [], handsOffTo: ['setPlatformTenantContext'],
    why: 'Raw-checkout helper: BEGIN, setPlatformTenantContext (the platform-constant GUC, no role), then fn(client) and COMMIT. It runs no table SQL itself; each caller (claimLease, takeOverStaleReset, release, returnClaim) is a checkout-callback entry.',
  },
  {
    file: 'src/demo/reset.ts', fn: 'claimLease', access: 'checkout-callback', count: 1,
    category: 'platform_constant_exception', tables: ['demo_tenant_leases', 'audit_events'], handsOffTo: ['writePlatformAudit'],
    dynamicSql: true,
    why: "The reset claim on inPlatformTransaction's client: the claimSql UPDATE of the RLS-exempt lease row (by server-held lease id) and writePlatformAudit's audit_events row pinned to DEMO_PLATFORM_TENANT_ID. The SQL is dynamic only in that claimSql(source) returns it: a fixed UPDATE demo_tenant_leases plus a source-chosen literal predicate (tables by review).",
  },
  {
    file: 'src/demo/reset.ts', fn: 'takeOverStaleReset', access: 'checkout-callback', count: 1,
    category: 'platform_constant_exception', tables: ['demo_tenant_leases', 'audit_events'], handsOffTo: ['writePlatformAudit'],
    why: "The reaper's takeover on inPlatformTransaction's client: UPDATE of the RLS-exempt lease row by id and stale heartbeat, then a platform-constant audit_events row through writePlatformAudit.",
  },
  {
    file: 'src/demo/reset.ts', fn: 'release', access: 'checkout-callback', count: 1,
    category: 'platform_constant_exception', tables: ['demo_tenant_leases', 'audit_events'], handsOffTo: ['writePlatformAudit'],
    why: "Releases the lease on inPlatformTransaction's client (UPDATE … WHERE id AND reset_token on the RLS-exempt lease table), then a platform-constant audit_events row. hooks.insideFence is the createDemoLeaseResetter test seam (its caller passes none).",
  },
  {
    file: 'src/demo/reset.ts', fn: 'returnClaim', access: 'checkout-callback', count: 1,
    category: 'platform_constant_exception', tables: ['demo_tenant_leases', 'audit_events'], handsOffTo: ['writePlatformAudit'],
    why: "Returns a failed reset's claim on inPlatformTransaction's client: UPDATE of the RLS-exempt lease row by id and token, then a platform-constant audit_events row through writePlatformAudit.",
  },
  {
    file: 'src/demo/reset.ts', fn: 'fenced', access: 'pool.connect', count: 1,
    category: 'global_table', tables: ['demo_tenant_leases'], handsOffTo: ['clearTenantContext'],
    why: "Raw-checkout helper: BEGIN, the FOR SHARE fence read on the RLS-exempt demo_tenant_leases row, then fn(client); clearTenantContext before release. The steps' tenant SQL is runSteps' checkout-callback entry.",
  },
  {
    file: 'src/demo/reset.ts', fn: 'runSteps', access: 'checkout-callback', count: 7,
    category: 'tenant_filtered_no_rls', tables: ['_queue_messages', 'demo_inflight_jobs', 'proposals', 'files', 'demo_tenant_leases'],
    handsOffTo: ['drainPredicate', 'queueStatement', 'reseed'], migrateBy: 'audit 2026-10-23 §4 P1.12',
    why: "Six fenced(…) steps and the purgeTenantRows beforeStep fence, all on the fenced principal client: queue purges, the drain count over demo_inflight_jobs/proposals and the files read (WHERE tenant_id = the lease tenant, GUC without the role), the object deletes, and reseed (seedDemoTenantFromFixture applies context itself). Demo tenants only (readIdentity refuses others).",
  },
  {
    file: 'src/demo/reset.ts', fn: 'startHeartbeat', access: 'pool.query', count: 1,
    category: 'global_table', tables: ['demo_tenant_leases'],
    why: 'Reset heartbeat UPDATE on the RLS-exempt demo_tenant_leases platform table, keyed by lease id and reset token.',
  },
  {
    file: 'src/demo/reset.ts', fn: 'runSteps', access: 'guc-only', count: 2,
    category: 'tenant_filtered_no_rls', tables: ['proposals', 'demo_inflight_jobs', 'files'],
    migrateBy: 'audit 2026-10-23 §4 P1.12',
    why: "The drain and object_delete steps set only set_config('app.current_tenant_id') on the fenced principal client before reading proposals/demo_inflight_jobs/files WHERE tenant_id = the lease tenant: GUC without the role, so RLS does not bind.",
  },
  {
    file: 'src/demo/reset.ts', fn: 'readIdentity', access: 'pool.query', count: 1,
    category: 'global_table', tables: ['tenants'],
    why: "Reads the lease tenant's tenants row (no RLS) and is the guard that refuses to reset anything that is not a demo pool tenant.",
  },
  {
    file: 'src/demo/reset.ts', fn: 'tenantOf', access: 'pool.query', count: 1,
    category: 'global_table', tables: ['demo_tenant_leases'],
    why: 'Discovers the tenant of a server-held lease id on the RLS-exempt demo_tenant_leases table (continueReset from the reaper).',
  },
  {
    file: 'src/demo/seed-pool.ts', fn: 'seedDemoTenantPool', access: 'pool.connect', count: 1,
    category: 'global_table', tables: ['tenants'], handsOffTo: ['clearTenantContext'],
    why: "Operator CLI demo pool seed. The raw statements on this client touch only the tenants registry (INSERT … ON CONFLICT, replay SELECT); the tenant-table seed runs inside seedDemoTenantFromFixture, which applies tenant context on the client first.",
  },
  {
    file: 'src/demo/service.ts', fn: 'startDemoCall', access: 'checkout-callback', count: 1,
    category: 'global_table', tables: ['tenants', 'demo_tenant_leases'], handsOffTo: ['insertLease'],
    why: "runStartTransaction's takeLease step is demoLeaseStep, whose insertLease picks a free demo tenant from the tenants registry and inserts the RLS-exempt lease row on the start transaction's client. Neither table is under RLS.",
  },
  {
    file: 'src/demo/service.ts', fn: 'inPlatformTransaction', access: 'pool.connect', count: 1,
    category: 'global_table', tables: [], handsOffTo: ['setPlatformTenantContext'],
    why: "Raw-checkout helper: BEGIN, setPlatformTenantContext (the platform-constant GUC, no role), then fn(client) and COMMIT. It runs no table SQL itself; its caller (settle) is a checkout-callback entry.",
  },
  {
    file: 'src/demo/service.ts', fn: 'settle', access: 'checkout-callback', count: 1,
    category: 'platform_constant_exception', tables: ['demo_tenant_leases', 'demo_calls', 'demo_call_budget', 'audit_events'],
    handsOffTo: ['releaseNoCall', 'releaseNoCall > releaseOn', 'releaseNoCall > writePlatformAudit', 'writePlatformAudit'],
    why: "Settles a public demo call on inPlatformTransaction's client: lease/demo_calls/demo_call_budget updates by server-held ids (releaseNoCall's releaseOn returns the allowance) and writePlatformAudit rows pinned to DEMO_PLATFORM_TENANT_ID. The visitor never supplies a tenant id.",
  },
  {
    file: 'src/demo/start-transaction.ts', fn: 'runStartTransaction', access: 'pool.connect', count: 1,
    category: 'platform_constant_exception', tables: ['phone_rate_limits', 'leads', 'audit_events', 'tenants', 'demo_tenant_leases', 'demo_call_budget', 'demo_calls'],
    handsOffTo: [
      'runSteps', 'runSteps > captureVisitorLead', 'runSteps > reserve', 'runSteps > tryConsumeOn',
      'runSteps > writePlatformAudit', 'setPlatformTenantContext',
    ],
    why: "The demo-call start transaction runs as the principal with the platform tenant's GUC and no role (the runtime role has no grant on the lease table). runSteps writes the allowance, lead, budget and demo_calls rows pinned to DEMO_PLATFORM_TENANT_ID and hands takeLease to the caller's steps (startDemoCall's entry).",
  },

  // ── digest/ estimates/ feedback/ flags/ ────────────────────────────────
  {
    file: 'src/digest/weekly-feedback-config.ts', fn: 'resolveTenantOwnerEmail', access: 'pool.query', count: 1,
    category: 'global_table', tables: ['tenants'],
    why: 'Weekly feedback worker reads owner_email FROM tenants WHERE id = $1 for the tenant it is digesting. tenants has no RLS.',
  },
  {
    file: 'src/estimates/pg-estimate.ts', fn: 'PgEstimateRepository.findByViewToken', access: 'withClient', count: 1,
    category: 'pre_tenant_lookup', tables: ['estimates'],
    why: 'Public /public/estimates/:token runs before any tenant is known. The only SQL calls the SECURITY DEFINER find_estimate_by_view_token (migration 119; exact match on the unique randomBytes(24) token), which returns (id, tenant_id); the body is then loaded with findById under withTenant.',
  },
  {
    file: 'src/feedback/pg-feedback-request.ts', fn: 'PgFeedbackRequestRepository.findByToken', access: 'withClient', count: 1,
    category: 'pre_tenant_lookup', tables: ['feedback_requests'],
    why: 'Public /public/feedback/:token runs before any tenant is known: SELECT * WHERE token = $1 on the UNIQUE randomBytes(24) token (the credential). Later reads and writes use withTenant(request.tenantId). Works only because the principal is BYPASSRLS.',
  },
  {
    file: 'src/flags/pg-feature-flags.ts', fn: 'PgFeatureFlagRepository.list', access: 'withClient', count: 1,
    category: 'global_table', tables: ['_feature_flags'], handsOffTo: ['this.ensureTable'],
    why: 'Lists the platform-wide _feature_flags table (no tenant_id, no RLS; per-tenant enablement is a tenant_ids array). Platform-admin route and the flag loader.',
  },
  {
    file: 'src/flags/pg-feature-flags.ts', fn: 'PgFeatureFlagRepository.get', access: 'withClient', count: 1,
    category: 'global_table', tables: ['_feature_flags'], handsOffTo: ['this.ensureTable'],
    why: "Point read by flag name from the platform-wide _feature_flags table (no tenant_id, no RLS). A tenant's view is decided in code from the tenant_ids array.",
  },
  {
    file: 'src/flags/pg-feature-flags.ts', fn: 'PgFeatureFlagRepository.upsert', access: 'withClient', count: 1,
    category: 'global_table', tables: ['_feature_flags'], handsOffTo: ['this.ensureTable'],
    why: 'Upsert by name into the platform-wide _feature_flags table, reached from the platform-admin-gated PUT and the boot seed. Write access is enforced by requirePlatformAdmin, not RLS.',
  },
  {
    file: 'src/flags/pg-feature-flags.ts', fn: 'PgFeatureFlagRepository.delete', access: 'withClient', count: 1,
    category: 'global_table', tables: ['_feature_flags'], handsOffTo: ['this.ensureTable'],
    why: 'Deletes one platform flag by name from _feature_flags (created by this file’s ensureTable DDL; no tenant_id, no RLS) behind the platform-admin router.',
  },

  // ── integrations/ ──────────────────────────────────────────────────────
  {
    file: 'src/integrations/accounting/repository.ts', fn: 'PgAccountingIntegrationRepository.findAllActive', access: 'withClient', count: 1,
    category: 'cross_tenant_intentional', tables: ['accounting_integrations'], migrateBy: 'audit 2026-10-23 §4 P3.2',
    why: "The leader-run accounting sync sweep lists every tenant's active integration; each row is then synced under its own tenantId. withClient never switches role, so the system_lookup GUC it sets is moot on a BYPASSRLS principal. Replace with withCrossTenantSweep.",
  },
  {
    file: 'src/integrations/accounting/repository.ts', fn: 'PgAccountingIntegrationRepository.findAllActive', access: 'guc-only', count: 1,
    category: 'cross_tenant_intentional', tables: ['accounting_integrations'], migrateBy: 'audit 2026-10-23 §4 P3.2',
    why: "set_config('app.system_lookup','true',true) inside the same BEGIN/COMMIT as the cross-tenant SELECT: migration 172's escape-hatch GUC, transaction-local so it cannot leak to the next checkout. Goes away with withCrossTenantSweep.",
  },
  {
    file: 'src/integrations/accounting/repository.ts', fn: 'PgAccountingOAuthStateRepository.create', access: 'pool.query', count: 1,
    category: 'global_table', tables: ['oauth_states'],
    why: 'INSERT of a QuickBooks OAuth state nonce into oauth_states, which is RLS-exempt by design (runtime role revoked, migration 219). tenant_id written is req.auth.tenantId.',
  },
  {
    file: 'src/integrations/accounting/repository.ts', fn: 'PgAccountingOAuthStateRepository.consume', access: 'pool.query', count: 1,
    category: 'global_table', tables: ['oauth_states'],
    why: 'The QuickBooks callback consumes its single-use, 5-minute state nonce and recovers tenant_id from it (the pre-tenant lookup), on the RLS-exempt oauth_states table. State is browser-bound since the F7 fix.',
  },
  {
    file: 'src/integrations/calendar-integration.ts', fn: 'PgOAuthStateRepository.create', access: 'pool.query', count: 1,
    category: 'global_table', tables: ['oauth_states'],
    why: 'Google OAuth state nonce INSERT into the RLS-exempt oauth_states table (runtime role revoked); tenant_id and user_id come from req.auth at /google/connect.',
  },
  {
    file: 'src/integrations/calendar-integration.ts', fn: 'PgOAuthStateRepository.consume', access: 'pool.query', count: 1,
    category: 'global_table', tables: ['oauth_states'],
    why: 'The unauthenticated Google callback atomically consumes its gen_random_uuid, single-use, provider-bound nonce and RETURNs tenant_id — the lookup that discovers the tenant — on the RLS-exempt oauth_states table.',
  },
  {
    file: 'src/integrations/credentials.ts', fn: 'getTenantTwilioCreds', access: 'pool.connect', count: 1,
    category: 'tenant_context_applied', tables: ['tenant_integrations'],
    why: "Per-tenant Twilio credentials on the outbound SMS path: own client, BEGIN + applyTenantContext before the tenant_integrations read (F4 fix). Under the role a read without context would fail closed.",
  },
  {
    file: 'src/integrations/credentials.ts', fn: 'listen', access: 'client.connect', count: 1,
    category: 'global_table', tables: [],
    why: 'Connects the dedicated LISTEN client for tenant_integration_rotated cache invalidation. Session pub/sub only; it reads no table.',
  },
  {
    file: 'src/integrations/twilio/phone-number-repository.ts', fn: 'PgPhoneNumberRepository.findByNumber', access: 'withClient', count: 1,
    category: 'pre_tenant_lookup', tables: ['tenant_integrations'],
    why: 'Inbound Twilio callbacks arrive with only the dialled DID; this maps phoneE164 to tenant_id (SELECT tenant_id only) before any tenant is known. DIDs are unique across tenants (#1061) and the signing credential is bound to the same lookup (#1072).',
  },
  {
    file: 'src/integrations/twilio/phone-number-repository.ts', fn: 'PgPhoneNumberRepository.findByNumber', access: 'guc-only', count: 1,
    category: 'pre_tenant_lookup', tables: ['tenant_integrations'],
    why: "set_config('app.system_lookup','true',true) inside the BEGIN/COMMIT around the DID lookup, for migration 074's read policy under an RLS-subject role. Transaction-local, so it cannot leak to the next checkout.",
  },
  {
    file: 'src/integrations/vapi/webhook.ts', fn: 'recordInboundSession', access: 'pool.connect', count: 1,
    category: 'tenant_context_applied', tables: ['voice_sessions'],
    why: 'Vapi call event: own client, BEGIN + applyTenantContext (F4 fix) before the idempotent voice_sessions read/insert. The tenant is the /vapi/:tenantId path authenticated by that tenant’s HMAC secret.',
  },
  {
    file: 'src/invoices/pg-invoice.ts', fn: 'PgInvoiceRepository.findByViewToken', access: 'withClient', count: 1,
    category: 'pre_tenant_lookup', tables: ['invoices'],
    why: 'Public invoice view/pay routes run before any tenant is known. The only SQL calls the SECURITY DEFINER find_invoice_by_view_token (migration 119; exact match on the unique randomBytes(24) view token), returning (id, tenant_id); findById then runs under withTenant.',
  },
  {
    file: 'src/invoices/pg-payment.ts', fn: 'PgPaymentRepository.findByProviderReferenceCrossTenant', access: 'withClient', count: 1,
    category: 'pre_tenant_lookup', tables: ['payments'],
    why: 'Stripe charge.refund.updated / charge.dispute.created carry no tenant metadata; the tenant is resolved from the signed event payment_intent via reference_number and then bound to event.account (#1109) before any withTenant write.',
  },
  {
    file: 'src/middleware/tenant-context.ts', fn: 'recoverTenantFromUsersRow', access: 'pool.query', count: 1,
    category: 'pre_tenant_lookup', tables: ['users'],
    why: "Runs before any tenant is known for a JWT without tenant_id, keyed by the verified Clerk subject; returns only that subject's own rows. Under rls_app_runtime it would see zero rows, so it must stay on the principal.",
  },

  // ── notifications/ ─────────────────────────────────────────────────────
  {
    file: 'src/notifications/lifecycle-email.ts', fn: 'claimLifecycleEmail', access: 'pool.query', count: 1,
    category: 'tenant_filtered_no_rls', tables: ['lifecycle_emails'], migrateBy: 'audit 2026-10-23 §4 P2.4',
    why: 'Raw INSERT into FORCE-RLS lifecycle_emails stamping tenant_id = $1 from a server-derived id (queue payload or sweep row); WITH CHECK is not enforced for the principal.',
  },
  {
    file: 'src/notifications/lifecycle-email.ts', fn: 'releaseLifecycleEmail', access: 'pool.query', count: 1,
    category: 'tenant_filtered_no_rls', tables: ['lifecycle_emails'], migrateBy: 'audit 2026-10-23 §4 P2.4',
    why: 'Transport-failure release: DELETE FROM lifecycle_emails WHERE tenant_id = $1 AND kind = $2 for the tenant that just claimed it, as the principal.',
  },
  {
    file: 'src/notifications/send-claim-ledger.ts', fn: 'claimSend', access: 'pool.query', count: 1,
    category: 'tenant_filtered_no_rls', tables: ['send_claims'], migrateBy: 'audit 2026-10-23 §4 P1.6',
    why: 'The SMS send-claim ledger under every proposal-execution, drip, thank-you and transactional send: a bare pool.query keyed by (tenant_id, claim_key) with a server-derived tenant. It commits independently of the request on purpose (P1.6 decision pending).',
  },
  {
    file: 'src/notifications/send-claim-ledger.ts', fn: 'markSendClaimSending', access: 'pool.query', count: 1,
    category: 'tenant_filtered_no_rls', tables: ['send_claims'], migrateBy: 'audit 2026-10-23 §4 P1.6',
    why: 'Send-claim state flip WHERE tenant_id = $1 AND claim_key = $2 on FORCE-RLS send_claims, as the principal, with the same server-derived tenant as claimSend.',
  },
  {
    file: 'src/notifications/send-claim-ledger.ts', fn: 'markSendClaimComplete', access: 'pool.query', count: 1,
    category: 'tenant_filtered_no_rls', tables: ['send_claims'], migrateBy: 'audit 2026-10-23 §4 P1.6',
    why: 'Marks a send claim complete, tenant-filtered by the internal tenantId (withSendClaim, outbound-messaging), outside RLS.',
  },
  {
    file: 'src/notifications/send-claim-ledger.ts', fn: 'releaseSendClaim', access: 'pool.query', count: 1,
    category: 'tenant_filtered_no_rls', tables: ['send_claims'], migrateBy: 'audit 2026-10-23 §4 P1.6',
    why: 'Tenant-filtered DELETE of a send claim from withSendClaim on failure, as the principal (FORCE-RLS send_claims).',
  },
  {
    file: 'src/notifications/send-claim-ledger.ts', fn: 'findStuckSendClaims', access: 'pool.query', count: 1,
    category: 'cross_tenant_intentional', tables: ['send_claims'], migrateBy: 'audit 2026-10-23 §4 P3.4',
    why: 'Operator-monitor sweep across all tenants with deliberately no tenant filter. It has no production caller (tests only): delete it, or wire it under withCrossTenantSweep (P3.4).',
  },
  {
    file: 'src/notifications/send-claim-ledger.ts', fn: 'readSendClaimStatus', access: 'pool.query', count: 1,
    category: 'tenant_filtered_no_rls', tables: ['send_claims'], migrateBy: 'audit 2026-10-23 §4 P1.6',
    why: 'Reads a send claim WHERE tenant_id = $1 AND claim_key = $2 with an internal tenantId (sendText, duplicateOutcome), as the principal.',
  },

  // ── onboarding/ ────────────────────────────────────────────────────────
  {
    file: 'src/onboarding/activate-pack-with-seed.ts', fn: 'activatePackWithSeed', access: 'pool.connect', count: 1,
    category: 'global_table', tables: [],
    why: "The executor-side lockPool checkout holds only a session pg_try_advisory_lock / pg_advisory_unlock on hashtextextended('pack:tenant:pack'); all data writes go through tenant-scoped repositories. Same shape as provision-twilio's phone lock.",
  },
  {
    file: 'src/onboarding/choices/price-tiers.ts', fn: 'PgRegionalPriceTierRepository.find', access: 'pool.query', count: 1,
    category: 'global_table', tables: ['regional_price_tiers'],
    why: 'regional_price_tiers is platform-owned and founder-curated (PK trade+metro_code, no tenant_id, no RLS); read while assembling the onboarding draft.',
  },
  {
    file: 'src/onboarding/choices/price-tiers.ts', fn: 'PgRegionalPriceTierRepository.upsert', access: 'pool.query', count: 1,
    category: 'global_table', tables: ['regional_price_tiers'],
    why: 'Admin write path into the platform regional_price_tiers table (no tenant_id, no RLS). No src or script caller, only integration tests (P4.2 dead-code candidate).',
  },
  {
    file: 'src/onboarding/load-facts.ts', fn: 'loadOnboardingFacts', access: 'ambient-or-pool', count: 7,
    category: 'tenant_filtered_no_rls',
    tables: ['tenant_integrations', 'tenants', 'voice_sessions', 'tenant_settings', 'pack_activations', 'onboarding_drafts', 'proposals'],
    migrateBy: 'audit 2026-10-23 §4 P1.11',
    why: 'db = currentTenantContext()?.client ?? pool: requests get the RLS request client, but the setup-reminder sweep has no context and falls back to the raw pool, so its seven reads rest only on WHERE tenant_id = $1 for a sweep-row tenant.',
  },

  // ── portal/ proposals/ public-intake/ push/ ────────────────────────────
  {
    file: 'src/portal/pg-portal-session.ts', fn: 'PgPortalSessionRepository.findByTokenHash', access: 'withClient', count: 1,
    category: 'pre_tenant_lookup', tables: ['portal_sessions'],
    why: 'Customer-portal auth: the sha256 token hash IS the credential and no tenant is known yet. BEGIN, the portal_token_lookup escape GUC (migration 107), SELECT by unique token_hash; resolvePortalSession re-checks the hash in constant time, expiry and revocation.',
  },
  {
    file: 'src/portal/pg-portal-session.ts', fn: 'PgPortalSessionRepository.findByTokenHash', access: 'guc-only', count: 1,
    category: 'pre_tenant_lookup', tables: ['portal_sessions'],
    why: "set_config('app.portal_token_lookup','true',true) inside the lookup's own BEGIN/COMMIT: the migration 107 escape hatch that admits the hash lookup under an RLS-subject role. Transaction-local; listed so a copy of it elsewhere fails the guard.",
  },
  {
    file: 'src/proposals/execution/executor.ts', fn: 'ProposalExecutor.execute', access: 'checkout-callback', count: 1,
    category: 'tenant_context_applied', tables: ['proposals', 'proposal_executions', 'audit_events'], handsOffTo: ['discardIfAborted'],
    why: "checkAndExecute's callback gets the advisory lock's client and opens every transaction on it through executeAudited (runInTenantTransaction: BEGIN + applyTenantContext) before the handler, the idempotency record, the status write and the audit row; discardIfAborted only releases or rolls back to the handler savepoint.",
  },
  {
    file: 'src/proposals/execution/idempotency.ts', fn: 'IdempotencyGuard.checkAndExecute', access: 'checkout-callback', count: 1,
    category: 'global_table', tables: [],
    why: "withLock's callback runs no SQL on the locked client: it reads the idempotency marker through tenant-scoped repositories and passes the client to executeFn, its own caller's callback (so checkAndExecute is a raw-checkout helper and ProposalExecutor.execute is listed).",
  },
  {
    file: 'src/proposals/execution/idempotency-lock.ts', fn: 'PgIdempotencyLockProvider.withLock', access: 'pool.connect', count: 1,
    category: 'global_table', tables: [], handsOffTo: ['<closure>', 'watchSessionLease', 'watchSessionLease > <closure>'],
    why: "Raw-checkout helper: a session advisory lock keyed by sha256(tenantId\\0idempotencyKey) on a directPool checkout (no table), watchSessionLease on the client's error/end (its stopWatching closure detaches them), then runWithSessionLease(lease, () => fn(client, lease)) — the caller's callback, listed per caller (IdempotencyGuard.checkAndExecute).",
  },
  {
    file: 'src/public-intake/public-business-info.ts', fn: 'resolvePublicBusinessPhone', access: 'pool.query', count: 1,
    category: 'tenant_filtered_no_rls', tables: ['tenant_integrations'], migrateBy: 'audit 2026-10-23 §4 P2.6',
    why: "Public intake / tenant site fallback for the tenant's own public phone: provider_data->>'phoneE164' FROM tenant_integrations WHERE tenant_id = $1 (UUID-validated, tenantRepo-checked URL tenant), as the principal.",
  },
  {
    file: 'src/push/pg-device-token-repository.ts', fn: 'PgDeviceTokenRepository.register', access: 'guc-only', count: 2,
    category: 'cross_tenant_intentional', tables: ['device_tokens'],
    migrateBy: 'audit 2026-10-23 §1.4 device_tokens (move the cleanup to withCrossTenantSweep, §4 P3.2 pattern)',
    why: "Inside withTenantTransaction it sets, then resets, app.system_lookup around DELETE FROM device_tokens WHERE expo_push_token = $1 AND tenant_id <> $2: the deliberate 'a device belongs to one tenant' cleanup through the migration 197/199 escape-hatch policy.",
  },

  // ── queues/ ────────────────────────────────────────────────────────────
  {
    file: 'src/queues/pg-queue.ts', fn: 'PgQueue.send', access: 'withClient', count: 1,
    category: 'global_table', tables: ['_queue_messages', '_queue_dlq'], handsOffTo: ['this.ensureTable', 'this.insertMessage'],
    why: 'Enqueue onto the platform job queue. _queue_messages/_queue_dlq have no tenant_id and no RLS (ensureTable DDL in this file); the tenant travels inside the server-built JSON payload.',
  },
  {
    file: 'src/queues/pg-queue.ts', fn: 'PgQueue.sendOn', access: 'withClient', count: 1,
    category: 'global_table', tables: ['_queue_messages', '_queue_dlq'], handsOffTo: ['this.ensureTable'],
    why: "withClient here runs only the one-time CREATE TABLE/ALTER bootstrap (ensureTable) on the queue's own connection; the INSERT itself runs on the caller's client inside the caller's transaction.",
  },
  {
    file: 'src/queues/pg-queue.ts', fn: 'PgQueue.receiveBatch', access: 'withClient', count: 1,
    category: 'global_table', tables: ['_queue_messages', '_queue_dlq'], handsOffTo: ['this.ensureTable'],
    why: 'Worker claim loop, cross-tenant by design: UPDATE … FOR UPDATE SKIP LOCKED over the global queue table and orphan reaping into _queue_dlq. Handlers trust the server-minted payload.tenantId.',
  },
  {
    file: 'src/queues/pg-queue.ts', fn: 'PgQueue.delete', access: 'withClient', count: 1,
    category: 'global_table', tables: ['_queue_messages', '_queue_dlq'], handsOffTo: ['this.ensureTable'],
    why: 'Ack: DELETE FROM _queue_messages WHERE id = $1 on the global queue table (no tenant_id, no RLS); the id comes from receiveBatch.',
  },
  {
    file: 'src/queues/pg-queue.ts', fn: 'PgQueue.findPending', access: 'withClient', count: 1,
    category: 'global_table', tables: ['_queue_messages', '_queue_dlq'], handsOffTo: ['this.ensureTable'],
    why: "PRIV-3 read-only lookup: SELECT of a job type's still-queued messages whose server-built payload contains the match (JSONB @>) on the global, non-RLS _queue_messages; claims nothing. Its one caller (pendingCardNumberRewrites, voice/card-number-rewrite-retry.ts) matches on the call's own tenantId and callSid, so the recording hook reads only that tenant's queued card-number rewrites.",
  },
  {
    file: 'src/queues/pg-queue.ts', fn: 'PgQueue.recordFailure', access: 'withClient', count: 1,
    category: 'global_table', tables: ['_queue_messages', '_queue_dlq'], handsOffTo: ['this.ensureTable'],
    why: 'T4-F10 diagnostic: UPDATE _queue_messages SET last_error by message id on the global, non-RLS queue table.',
  },
  {
    file: 'src/queues/pg-queue.ts', fn: 'PgQueue.moveToDeadLetter', access: 'withClient', count: 1,
    category: 'global_table', tables: ['_queue_messages', '_queue_dlq'], handsOffTo: ['this.ensureTable'],
    why: 'Moves an exhausted message into the global _queue_dlq (payload redacted by redactForSink) and deletes it from _queue_messages in one transaction on non-RLS tables.',
  },
  {
    file: 'src/queues/pg-queue.ts', fn: 'PgQueue.listDeadLetter', access: 'withClient', count: 1,
    category: 'global_table', tables: ['_queue_messages', '_queue_dlq'], handsOffTo: ['this.ensureTable'],
    why: 'Operator view of the whole global DLQ (no tenant_id, no RLS). No production caller (tests and the in-memory twin only); wiring it to a tenant route would disclose every tenant’s redacted payloads.',
  },
  {
    file: 'src/queues/pg-queue.ts', fn: 'PgQueue.depth', access: 'withClient', count: 1,
    category: 'global_table', tables: ['_queue_messages', '_queue_dlq'], handsOffTo: ['this.ensureTable'],
    why: 'Backlog SLO sampler: COUNT(*) over the global queue and DLQ tables. Aggregate counts only.',
  },
  {
    file: 'src/queues/pg-queue.ts', fn: 'PgQueue.stalePendingCount', access: 'withClient', count: 1,
    category: 'global_table', tables: ['_queue_messages', '_queue_dlq'], handsOffTo: ['this.ensureTable'],
    why: 'WS15 stuck-queue alarm: COUNT(*) of overdue visible messages in the global non-RLS queue table.',
  },

  // ── routes/ ────────────────────────────────────────────────────────────
  {
    file: 'src/routes/admin-tenants.ts', fn: 'POST /:tenantId/deprovision', access: 'pool.query', count: 1,
    category: 'global_table', tables: ['tenants'],
    why: 'Platform-admin deprovision: existence check on the non-RLS tenants registry for the UUID-validated route tenant, behind requireAuth + requirePlatformAdmin; it only enqueues the job.',
  },
  {
    file: 'src/routes/onboarding.ts', fn: 'PUT /identity', access: 'ambient-or-pool', count: 1,
    category: 'tenant_context_applied', tables: ['tenant_settings'],
    why: "requireTenant route under app.use('/api', withTenantTransaction(pool)), so db is the request client with applyTenantContext; the UPDATE tenant_settings is also filtered by req.auth.tenantId. The ?? pool fallback is only a latent raw path.",
  },
  {
    file: 'src/routes/onboarding.ts', fn: 'POST /test-call/skip', access: 'ambient-or-pool', count: 1,
    category: 'tenant_context_applied', tables: ['tenant_settings'],
    why: 'Request-client UPDATE of onboarding_test_call_skipped_at under the /api withTenantTransaction middleware, tenant from req.auth.tenantId. The pool fallback is latent only.',
  },
  {
    file: 'src/routes/onboarding.ts', fn: 'GET /operator-hours', access: 'ambient-or-pool', count: 1,
    category: 'tenant_context_applied', tables: ['tenant_settings'],
    why: 'Request-client read of business_hours under the /api withTenantTransaction middleware, WHERE tenant_id = req.auth.tenantId. The pool fallback is latent only.',
  },
  {
    file: 'src/routes/onboarding.ts', fn: 'PUT /operator-hours', access: 'ambient-or-pool', count: 1,
    category: 'tenant_context_applied', tables: ['tenant_settings'],
    why: 'Owner-only request-client UPDATE of business_hours under the /api withTenantTransaction middleware, tenant from req.auth.tenantId. The pool fallback is latent only.',
  },
  {
    file: 'src/routes/onboarding.ts', fn: 'GET /phone', access: 'ambient-or-pool', count: 1,
    category: 'tenant_context_applied', tables: ['tenant_integrations'],
    why: "Request-client read of the tenant's twilio tenant_integrations row under the /api withTenantTransaction middleware. The pool fallback is latent only.",
  },
  {
    file: 'src/routes/onboarding.ts', fn: 'POST /calendar/choose', access: 'ambient-or-pool', count: 1,
    category: 'tenant_context_applied', tables: ['tenant_settings'],
    why: 'Owner-only request-client UPDATE of calendar_provider under the /api withTenantTransaction middleware, tenant from req.auth.tenantId. The pool fallback is latent only.',
  },
  {
    file: 'src/routes/public-intake.ts', fn: 'createPublicIntakeRouter', access: 'pool.query', count: 2,
    category: 'tenant_filtered_no_rls', tables: ['tenant_settings', 'google_reviews'], migrateBy: 'audit 2026-10-23 §4 P2.6',
    why: "Unauthenticated GET /:tenantId (UUID-validated, tenantRepo-checked): business_hours FROM tenant_settings and AVG/COUNT FROM google_reviews WHERE tenant_id = $1, the URL tenant's own public header data, on the raw pool.",
  },

  // ── seed/ ──────────────────────────────────────────────────────────────
  {
    file: 'src/seed/seed-runner.ts', fn: 'insertOwnerUser', access: 'pool.connect', count: 1,
    category: 'tenant_filtered_no_rls', tables: ['users'], migrateBy: 'audit 2026-10-23 §4 P2.9',
    why: 'Operator CLI seed: INSERT INTO users (FORCE RLS) on a raw client with only a hand-set session GUC and no role, so WITH CHECK never applies. tenant_id is the id PgTenantRepository.create just returned.',
  },
  {
    file: 'src/seed/seed-runner.ts', fn: 'insertOwnerUser', access: 'guc-only', count: 1,
    category: 'tenant_filtered_no_rls', tables: ['users'], migrateBy: 'audit 2026-10-23 §4 P2.9',
    why: "Session-level set_config('app.current_tenant_id', $1, false) outside any transaction (unsafe under PgBouncer transaction pooling), with no SET ROLE: not applyTenantContext. Operator CLI only.",
  },
  {
    file: 'src/seed/seed-runner.ts', fn: 'cleanSeed', access: 'pool.query', count: 1,
    category: 'global_table', tables: ['tenants'],
    why: "seed --clean enumerates seeded tenants from the non-RLS tenants registry by owner_email LIKE 'owner@seed-tenant-%' (audit F11: the marker is only a prefix). Operator CLI.",
  },
  {
    file: 'src/seed/seed-runner.ts', fn: 'cleanSeed', access: 'pool.connect', count: 1,
    category: 'tenant_filtered_no_rls', dynamicSql: true,
    tables: ['appointments', 'estimates', 'jobs', 'service_locations', 'customers', 'audit_events', 'users', 'tenants'],
    migrateBy: 'audit 2026-10-23 §4 P2.9',
    why: 'Per seeded tenant: dynamic DELETE FROM <table> WHERE tenant_id = $1 over a hardcoded child-table list, then DELETE FROM tenants, on a raw client with only a hand-set GUC (no role). The tenant comes from the cleanSeed enumeration; operator CLI.',
  },
  {
    file: 'src/seed/seed-runner.ts', fn: 'cleanSeed', access: 'guc-only', count: 1,
    category: 'tenant_filtered_no_rls', tables: ['appointments', 'estimates', 'jobs', 'service_locations', 'customers', 'audit_events', 'users'],
    migrateBy: 'audit 2026-10-23 §4 P2.9',
    why: 'Hand-set session GUC before BEGIN with no role switch, so the following child-table DELETEs run as the principal; isolation is their WHERE tenant_id = $1. Operator CLI.',
  },

  // ── shared/ ────────────────────────────────────────────────────────────
  {
    file: 'src/shared/pg-vertical-pack-registry.ts', fn: 'PgVerticalPackRegistry.register', access: 'withClient', count: 1,
    category: 'global_table', tables: ['vertical_packs'],
    why: 'Startup seeding of the platform vertical-pack catalog. vertical_packs has no tenant_id and no RLS; the upsert only refreshes canonical or createApp rows.',
  },
  {
    file: 'src/shared/pg-vertical-pack-registry.ts', fn: 'PgVerticalPackRegistry.get', access: 'withClient', count: 1,
    category: 'global_table', tables: ['vertical_packs'],
    why: 'Read of the global vertical-pack catalog by id. vertical_packs carries no tenant_id and is outside the FORCE-RLS census.',
  },
  {
    file: 'src/shared/pg-vertical-pack-registry.ts', fn: 'PgVerticalPackRegistry.getByPackId', access: 'withClient', count: 1,
    category: 'global_table', tables: ['vertical_packs'],
    why: 'Read of the global vertical-pack catalog by pack id. The table has no tenant_id and no RLS.',
  },
  {
    file: 'src/shared/pg-vertical-pack-registry.ts', fn: 'PgVerticalPackRegistry.findByVertical', access: 'withClient', count: 1,
    category: 'global_table', tables: ['vertical_packs'],
    why: "Read of the global pack catalog filtered by terminology->>'_verticalType'. The table has no tenant_id and no RLS.",
  },
  {
    file: 'src/shared/pg-vertical-pack-registry.ts', fn: 'PgVerticalPackRegistry.list', access: 'withClient', count: 1,
    category: 'global_table', tables: ['vertical_packs'],
    why: 'Lists the whole global vertical-pack catalog. vertical_packs has no tenant_id and is not FORCE RLS.',
  },
  {
    file: 'src/shared/pg-vertical-pack-registry.ts', fn: 'PgVerticalPackRegistry.update', access: 'withClient', count: 1,
    category: 'global_table', tables: ['vertical_packs'], dynamicSql: true,
    why: 'Updates a global pack-catalog row by id. The SQL is dynamic: UPDATE vertical_packs SET <setClauses joined> is built from column = $n literals for the fields present, so its tables are by review (vertical_packs only). Its only callers (activatePackStatus/deprecatePack) have no callers themselves; a global mutation that must stay platform-admin-gated if ever wired.',
  },

  // ── telephony/ ─────────────────────────────────────────────────────────
  {
    file: 'src/telephony/business-hours-loader.ts', fn: 'loadTenantBusinessHours', access: 'pool.query', count: 1,
    category: 'tenant_filtered_no_rls', tables: ['tenant_settings'], migrateBy: 'audit 2026-10-23 §4 P1.3',
    why: 'business_hours/timezone FROM tenant_settings WHERE tenant_id = $1 on a (pool: Pool) helper: the inbound voice after-hours check (dialled-number tenant) and /api/analytics/voice-roi (JWT tenant, on a second connection).',
  },
  {
    file: 'src/telephony/twilio-webhook-credential.ts', fn: 'systemLookup', access: 'pool.connect', count: 1,
    category: 'global_table', tables: [],
    why: 'Raw-checkout helper: BEGIN, the system_lookup GUC, then run(client) and COMMIT on a principal client. It reads no table itself; each caller is a checkout-callback entry with its own category (two pre-tenant lookups and findByTenant).',
  },
  {
    file: 'src/telephony/twilio-webhook-credential.ts', fn: 'systemLookup', access: 'guc-only', count: 1,
    category: 'pre_tenant_lookup', tables: ['tenant_integrations'],
    why: "set_config('app.system_lookup','true',true) inside systemLookup's own transaction: the escape-hatch GUC for migration 074's permissive read policy. Transaction-local; moot on a BYPASSRLS principal. findByTenant runs under it too (P1.7).",
  },
  {
    file: 'src/telephony/twilio-webhook-credential.ts', fn: 'findByPhoneNumber', access: 'checkout-callback', count: 1,
    category: 'pre_tenant_lookup', tables: ['tenant_integrations'],
    why: "Inbound Twilio webhook before HMAC verification: the dialled DID (normalised E.164) picks the twilio tenant_integrations row whose token verifies the signature; DIDs are unique across tenants (#1061). The tokens never leave the verifier.",
  },
  {
    file: 'src/telephony/twilio-webhook-credential.ts', fn: 'findByTenant', access: 'checkout-callback', count: 1,
    category: 'tenant_filtered_no_rls', tables: ['tenant_integrations'], migrateBy: 'audit 2026-10-23 §4 P1.7',
    why: "The tenant is already known (a trusted voice-session tenant), yet the read runs on systemLookup's principal client under system_lookup: WHERE provider = 'twilio' AND tenant_id = $1 is the only boundary. Should use tenant context instead.",
  },
  {
    file: 'src/telephony/twilio-webhook-credential.ts', fn: 'findBySubaccount', access: 'checkout-callback', count: 1,
    category: 'pre_tenant_lookup', tables: ['tenant_integrations'],
    why: "Twilio status/subaccount callbacks before HMAC verification: AccountSid picks the twilio tenant_integrations row whose token verifies the signature (subaccount SIDs are per tenant). The tokens never leave the verifier.",
  },

  // ── tenants/ ───────────────────────────────────────────────────────────
  {
    file: 'src/tenants/deprovision.ts', fn: 'readTwilioIntegration', access: 'pool.connect', count: 1,
    category: 'tenant_filtered_no_rls', tables: ['tenant_integrations'], migrateBy: 'audit 2026-10-23 §4 P2.8',
    why: "Reads the tenant's own twilio tenant_integrations row before releasing its subaccount, with only set_config and no role, so the policy does not bind the principal. Tenant is the UUID-validated admin/queue/script payload.",
  },
  {
    file: 'src/tenants/deprovision.ts', fn: 'readTwilioIntegration', access: 'guc-only', count: 1,
    category: 'tenant_filtered_no_rls', tables: ['tenant_integrations'], migrateBy: 'audit 2026-10-23 §4 P2.8',
    why: "set_config('app.current_tenant_id', $1, true) as the only 'context' for the deprovision credential read: GUC without the runtime role. Swap for applyTenantContext inside the existing BEGIN.",
  },
  {
    file: 'src/tenants/deprovision.ts', fn: 'deprovisionTenant', access: 'pool.query', count: 2,
    category: 'global_table', tables: ['tenants', 'platform_deprovision_log'],
    why: 'Existence check on the tenants registry and the platform_deprovision_log write (RLS-exempt by design: it outlives the purged tenant).',
  },
  {
    file: 'src/tenants/deprovision.ts', fn: 'deprovisionTenant', access: 'pool.connect', count: 1,
    category: 'cross_tenant_intentional', tables: ['files', 'tenants'], dynamicSql: true,
    handsOffTo: ['purgeTenantRows', 'purgeTenantRows > deleteBatch', 'purgeTenantRows > isPool', 'purgeTenantRows > listTenantTables'],
    migrateBy: 'audit 2026-10-23 §4 P3.3',
    why: 'Privileged single-tenant purge: BEGIN; SET LOCAL session_replication_role = replica (needs a superuser-class principal, so it cannot run as rls_app_runtime), files harvest, purgeTenantRows (dynamic DELETE FROM "<table>" WHERE tenant_id = $1 per tenant_id table) and the tenants delete, all keyed on one UUID-validated tenant. Attribution (applyCrossTenantRole) is P3.3.',
  },
  {
    file: 'src/tenants/list-tenant-ids.ts', fn: 'listAllTenantIds', access: 'pool.query', count: 1,
    category: 'global_table', tables: ['tenants'],
    why: 'The tenant enumerator every per-tenant sweep runs on: ids FROM tenants (no RLS) excluding demo and platform tenants. Downstream work applies tenant context itself.',
  },
  {
    file: 'src/tenants/purge-walk.ts', fn: 'listTenantTables', access: 'ambient-or-pool', count: 1,
    category: 'global_table', tables: ['information_schema.columns'],
    why: 'Discovers every public table with a tenant_id column from information_schema.columns for the purge walk (identifier-regex guarded). Catalog metadata only.',
  },
  {
    file: 'src/tenants/purge-walk.ts', fn: 'purgeTenantRows', access: 'ambient-or-pool', count: 1,
    category: 'cross_tenant_intentional', tables: [], dynamicSql: true, migrateBy: 'audit 2026-10-23 §4 P3.3',
    why: 'Dynamic SQL: DELETE FROM "<table_name>" WHERE tenant_id = $1 over every tenant_id table, on deprovision\'s privileged replica-mode client. The privileged principal is required (session_replication_role, RLS-exempt tables); only attribution is missing.',
  },
  {
    file: 'src/tenants/purge-walk.ts', fn: 'deleteBatch', access: 'pool.connect', count: 1,
    category: 'cross_tenant_intentional', tables: [], dynamicSql: true, migrateBy: 'audit 2026-10-23 §4 P3.3',
    why: "Batched demo-tenant wipe: dynamic DELETE FROM \"<table>\" WHERE tenant_id = $1 AND ctid = ANY(… WHERE tenant_id = $1 LIMIT $2) in replica mode on its own principal client; the tenant is the demo lease tenant, checked by readIdentity first.",
  },
  {
    file: 'src/tenants/purge-walk.ts', fn: 'deleteBatch', access: 'guc-only', count: 1,
    category: 'cross_tenant_intentional', tables: [], migrateBy: 'audit 2026-10-23 §4 P3.3',
    why: "set_config('app.current_tenant_id', $1, true) in each purge batch with no role: it only matters for a non-bypass principal. Attribution via applyCrossTenantRole is P3.3 (check the replica-mode SET still succeeds next to it).",
  },

  // ── users/ verticals/ ──────────────────────────────────────────────────
  {
    file: 'src/users/pg-pending-invitation.ts', fn: 'PgPendingInvitationRepository.findPendingByEmail', access: 'pool.query', count: 1,
    category: 'pre_tenant_lookup', tables: ['pending_invitations'],
    why: 'Clerk user.created fallback (no invitation_id in metadata) looks up the newest pending invitation by email across tenants: the webhook arrives with no tenant. FORCE RLS with no escape policy, so it depends on a BYPASSRLS principal (audit F5).',
  },
  {
    file: 'src/users/pg-pending-invitation.ts', fn: 'PgPendingInvitationRepository.findById', access: 'pool.query', count: 1,
    category: 'pre_tenant_lookup', tables: ['pending_invitations'],
    why: 'Clerk user.created looks up the unguessable invitation id from server-set public_metadata before any tenant is known; the caller also requires the email to match and rejects accepted rows.',
  },
  {
    file: 'src/users/pg-pending-invitation.ts', fn: 'PgPendingInvitationRepository.markAccepted', access: 'pool.query', count: 1,
    category: 'pre_tenant_lookup', tables: ['pending_invitations'], migrateBy: 'audit 2026-10-23 §4 P2.2',
    why: 'UPDATE … SET accepted_at WHERE id = $1 by PK in the same pre-tenant webhook flow; the id is the row the webhook just matched. The tenant is known by now, so it should move to withTenant(pending.tenantId) + AND tenant_id.',
  },
  {
    file: 'src/verticals/training-asset-service.ts', fn: 'TrainingAssetService.withPersistence', access: 'pool.connect', count: 1,
    category: 'tenant_context_applied', tables: ['vertical_training_assets', 'privacy_audit', 'audit_events'],
    why: 'Training-asset create/transition: the checkout goes straight into runInTenantTransaction (BEGIN + applyTenantContext + tenantContextStore), so every repository write on it carries the tenant role.',
  },

  // ── voice/ ─────────────────────────────────────────────────────────────
  {
    file: 'src/voice/activation.ts', fn: 'maybeFireFirstRealCallActivation', access: 'pool.query', count: 4,
    category: 'tenant_filtered_no_rls', tables: ['tenants', 'tenant_settings', 'voice_sessions'], migrateBy: 'audit 2026-10-23 §4 P1.5',
    why: 'Voice session-end hook on the raw pool at call teardown: a tenants read plus tenant_settings/voice_sessions reads and an UPDATE, each WHERE tenant_id = $1 with the server-side session tenant, as the principal.',
  },
  {
    file: 'src/voice/activation.ts', fn: 'maybeFireActivationForInboundCall', access: 'pool.query', count: 3,
    category: 'tenant_filtered_no_rls', tables: ['tenants', 'tenant_settings'], migrateBy: 'audit 2026-10-23 §4 P1.2',
    why: 'Verified Vapi webhook activation: tenants read plus a tenant_settings read and UPDATE WHERE tenant_id = $1 on the raw pool, the tenant being the HMAC-authenticated /vapi/:tenantId path.',
  },
  {
    file: 'src/voice/check-upgrade-nudge.ts', fn: 'checkAndFireUpgradeNudge', access: 'pool.query', count: 2,
    category: 'tenant_filtered_no_rls', tables: ['tenant_settings'], migrateBy: 'audit 2026-10-23 §4 P1.5',
    why: 'Voice session-end hook: SELECT then check-and-set UPDATE of tenant_settings WHERE tenant_id = $1 with the session tenant fixed at inbound session creation, on the raw pool.',
  },
  {
    file: 'src/voice/go-live.ts', fn: 'loadVoiceAgentLiveAt', access: 'pool.query', count: 1,
    category: 'tenant_filtered_no_rls', tables: ['tenant_settings'], migrateBy: 'audit 2026-10-23 §4 P1.3',
    why: 'Reads tenant_settings.voice_agent_live_at WHERE tenant_id = $1 on the raw pool: the /voice gate (signature-verified dialled-number tenant) and the go-live paths.',
  },
  {
    file: 'src/voice/go-live.ts', fn: 'subscriptionAllowsVoice', access: 'pool.query', count: 1,
    category: 'global_table', tables: ['tenants'],
    why: 'SELECT subscription_status FROM tenants WHERE id = $1 (req.auth tenant or session tenant). tenants has no RLS.',
  },
  {
    file: 'src/voice/go-live.ts', fn: 'enableVoiceAgentLive', access: 'pool.query', count: 1,
    category: 'tenant_filtered_no_rls', tables: ['tenant_settings'], migrateBy: 'audit 2026-10-23 §4 P1.5',
    why: 'POST /go-live and the session-end auto go-live: UPDATE tenant_settings WHERE tenant_id = $1 AND voice_agent_live_at IS NULL on the raw pool (req.auth or session tenant).',
  },
  {
    file: 'src/voice/go-live.ts', fn: 'pauseVoiceAgentLive', access: 'pool.query', count: 1,
    category: 'tenant_filtered_no_rls', tables: ['tenant_settings'], migrateBy: 'audit 2026-10-23 §4 P1.5',
    why: 'POST /pause: UPDATE tenant_settings WHERE tenant_id = $1 (req.auth tenant) on the raw pool instead of the request client.',
  },
  {
    file: 'src/voice/outbound-consent.ts', fn: 'checkOutboundConsent', access: 'pool.connect', count: 1,
    category: 'tenant_context_applied', tables: ['tenant_dnc_list', 'customers', 'consent_events'],
    why: 'TCPA gate for outbound AI calls and drip calls: own client, BEGIN + applyTenantContext before the DNC, customer consent and consent_events reads (each also tenant-filtered).',
  },
  {
    file: 'src/voice/outbound-consent.ts', fn: 'recordCustomerConsent', access: 'pool.connect', count: 1,
    category: 'tenant_context_applied', tables: ['customers'],
    why: 'Voice-consent write seam: BEGIN + applyTenantContext before the customers read and update. Kept on purpose with no production caller yet (its doc says so).',
  },
  {
    file: 'src/voice/voice-config.ts', fn: 'saveVoiceConfig', access: 'pool.query', count: 2,
    category: 'tenant_context_applied', tables: ['tenant_settings'],
    why: "Its only caller (PUT /api/onboarding/voice) passes db = currentTenantContext()?.client ?? pool, cast to Pool. The route is under the /api withTenantTransaction middleware and on neither skip list, so in a served request db is the request client and both tenant_settings statements run under applyTenantContext. With no tenant context active (the route moved onto a skip list, the middleware not mounted) it falls back to the raw principal pool, where WHERE tenant_id = $1 is the only boundary: latent, like the other onboarding ?? pool entries. A second caller passing a real Pool would be the same, and is not a site of its own.",
  },
  {
    file: 'src/voice/voice-config.ts', fn: 'refreshVapiFirstMessage', access: 'pool.query', count: 1,
    category: 'tenant_context_applied', tables: ['tenant_settings'],
    why: "Its one caller, the PATCH /api/settings/language after-commit re-push (routes/settings.ts), passes { query } wrapping tenantQuery(pool, tenantId, …), so the tenant_settings read runs under rls_app_runtime for that tenant. (scripts/backfill-vapi-assistant-notice.ts runs the same read through tenantQuery itself and does not call this.) The Pick<Pool, 'query'> parameter is a latent trap for a future raw caller.",
  },
  {
    file: 'src/voice/voice-gate.ts', fn: 'createVoiceGate', access: 'pool.query', count: 2,
    category: 'tenant_filtered_no_rls', tables: ['tenant_settings', 'voice_sessions'], migrateBy: 'audit 2026-10-23 §4 P1.3',
    why: 'The inbound /voice gate reads owner_phone and the live-call count for the dialled-number tenant on the raw pool; WHERE tenant_id = $1 is the only boundary. One withTenantSession per decision is the fix.',
  },
  {
    file: 'src/voice/voice-gate.ts', fn: 'isOwnersOwnNumber', access: 'pool.query', count: 1,
    category: 'tenant_filtered_no_rls', tables: ['tenant_settings'], migrateBy: 'audit 2026-10-23 §4 P1.3',
    why: "The #1605 owner test-call bypass compares From with the dialled tenant's owner/business phone FROM tenant_settings WHERE tenant_id = $1 on the raw pool; returns a boolean only.",
  },
  {
    file: 'src/voice/voice-service.ts', fn: 'recordInboundCall', access: 'pool.connect', count: 1,
    category: 'tenant_context_applied', tables: ['voice_recordings', 'files'],
    why: 'Recording/voicemail ingest: BEGIN + applyTenantContext, then the per-recording advisory lock, the voice_recordings FOR UPDATE read and the files/voice_recordings inserts, all under the tenant role.',
  },

  // ── webhooks/ ──────────────────────────────────────────────────────────
  {
    file: 'src/webhooks/integration-resolver.ts', fn: 'createIntegrationResolver', access: 'pool.connect', count: 1,
    category: 'tenant_context_applied', tables: ['tenant_integrations'],
    why: "Per-tenant inbound-webhook credential: own client, BEGIN + applyTenantContext (imported dynamically) before the tenant_integrations read. A forged URL tenant only yields that tenant's credential, which then fails the signature.",
  },
  {
    file: 'src/webhooks/integration-resolver.ts', fn: 'createVapiSecretResolver', access: 'pool.connect', count: 1,
    category: 'tenant_context_applied', tables: ['tenant_settings'],
    why: "Vapi webhook secret: own client, BEGIN + applyTenantContext before reading tenant_settings.vapi_webhook_secret; the secret only verifies that request's signature and the route fails closed.",
  },
  {
    file: 'src/webhooks/pg-webhook-event.ts', fn: 'PgWebhookEventRepository.recordReceipt', access: 'withClient', count: 1,
    category: 'global_table', tables: ['webhook_events'],
    why: 'Idempotent receipt of signature-verified provider webhooks keyed by (source, provider event id). webhook_events has no tenant_id and no RLS.',
  },
  {
    file: 'src/webhooks/pg-webhook-event.ts', fn: 'PgWebhookEventRepository.markProcessed', access: 'withClient', count: 1,
    category: 'global_table', tables: ['webhook_events'],
    why: 'Status flip on the global webhook_events table, keyed by the verified (source, provider event id) used at receipt.',
  },
  {
    file: 'src/webhooks/pg-webhook-event.ts', fn: 'PgWebhookEventRepository.markFailed', access: 'withClient', count: 1,
    category: 'global_table', tables: ['webhook_events'],
    why: 'Status flip to failed on the global webhook_events table. No production caller (tests only): a dead-code candidate.',
  },
  {
    file: 'src/webhooks/pg-webhook-event.ts', fn: 'PgWebhookEventRepository.findById', access: 'withClient', count: 1,
    category: 'global_table', tables: ['webhook_events'],
    why: 'Point read of a receipt by (source, key) on the global webhook_events table (the voicemail status route).',
  },
  {
    file: 'src/webhooks/pg-webhook-event.ts', fn: 'PgWebhookEventRepository.findUnprocessed', access: 'withClient', count: 1,
    category: 'global_table', tables: ['webhook_events'],
    why: "Retry-worker scan of received rows across the global webhook_events table. No production caller (tests and the in-memory twin only); wiring it to a tenant surface would leak.",
  },
  {
    file: 'src/webhooks/pg-webhook.ts', fn: 'PgWebhookRepository.findByIdempotencyKey', access: 'withClient', count: 1,
    category: 'global_table', tables: ['webhook_events'],
    why: 'Dedup read for handleWebhookEvent on the global webhook_events table, keyed by (source, provider idempotency key). No tenant_id, no RLS.',
  },
  {
    file: 'src/webhooks/pg-webhook.ts', fn: 'PgWebhookRepository.create', access: 'withClient', count: 1,
    category: 'global_table', tables: ['webhook_events'],
    why: 'Idempotent INSERT … ON CONFLICT (source, idempotency_key) DO NOTHING into global webhook_events, re-reading the existing row on conflict.',
  },
  {
    file: 'src/webhooks/pg-webhook.ts', fn: 'PgWebhookRepository.claimForRetry', access: 'withClient', count: 1,
    category: 'global_table', tables: ['webhook_events'],
    why: 'P0-8 compare-and-swap retry claim by the server-assigned webhook_events.id on the global, non-RLS table.',
  },
  {
    file: 'src/webhooks/pg-webhook.ts', fn: 'PgWebhookRepository.updateStatus', access: 'withClient', count: 1,
    category: 'global_table', tables: ['webhook_events'],
    why: 'Status and error update by server-assigned id on the global webhook_events table (including refuseUnboundStripeEvent).',
  },
  {
    file: 'src/webhooks/routes.ts', fn: 'enqueueTwilioNumberRelease', access: 'pool.query', count: 1,
    category: 'global_table', tables: ['tenants'],
    why: "Resolves the tenant from the signed Stripe event's customer id on the tenants registry (no RLS), only to enqueue a release of that tenant's own Twilio number.",
  },
  {
    file: 'src/webhooks/routes.ts', fn: 'resolveTenantConnectAccountId', access: 'pool.query', count: 1,
    category: 'global_table', tables: ['tenants'],
    why: 'Fallback read of tenants.stripe_connect_account_id (isValidTenantId-gated) for the #1102 event.account binding check; an unknown tenant fails closed.',
  },
  {
    file: 'src/webhooks/routes.ts', fn: 'POST /clerk', access: 'pool.connect', count: 2,
    category: 'tenant_filtered_no_rls', tables: ['users'], migrateBy: 'audit 2026-10-23 §4 P2.2',
    why: "user.created invitee join and owner membership: each opens a client, BEGIN + set_config GUC (no role) and INSERTs into users with tenant_id = the invitation row's / bootstrap tenant, so WITH CHECK is not enforced. Swap set_config for applyTenantContext.",
  },
  {
    file: 'src/webhooks/routes.ts', fn: 'POST /clerk', access: 'guc-only', count: 2,
    category: 'tenant_filtered_no_rls', tables: ['users'], migrateBy: 'audit 2026-10-23 §4 P2.2',
    why: "The two set_config('app.current_tenant_id', $1, true) lines of the Clerk users inserts: GUC without the runtime role, so the comment's 'fails the RLS policy without it' does not hold.",
  },
  {
    file: 'src/webhooks/routes.ts', fn: 'POST /clerk', access: 'pool.query', count: 1,
    category: 'cross_tenant_intentional', tables: ['users'], migrateBy: 'audit 2026-10-23 §4 P3.2',
    why: "user.deleted soft-deletes every membership row of the Svix-verified Clerk user id across tenants (UPDATE users … WHERE clerk_user_id = $1). Intentional, but unattributed; under rls_app_runtime it would match 0 rows.",
  },
  {
    file: 'src/webhooks/routes.ts', fn: 'POST /stripe', access: 'pool.query', count: 5,
    category: 'tenant_filtered_no_rls', tables: ['tenants', 'tenant_settings'], migrateBy: 'audit 2026-10-23 §4 P1.10',
    why: 'Signed Stripe events: four tenants-registry lookups/updates by session or customer id (no RLS) plus the AI-model seed UPDATE tenant_settings WHERE tenant_id = $1 (FORCE RLS) as the principal; that one is the debt.',
  },
  {
    file: 'src/webhooks/routes.ts', fn: 'POST /stripe', access: 'pool.connect', count: 1,
    category: 'global_table', tables: ['tenants'],
    why: 'customer.subscription.*: one transaction with SELECT … FOR UPDATE on the tenants row (by metadata tenant or customer id) and the subscription mirror UPDATEs, tenants only, serialising concurrent events.',
  },

  // ── workers/ ───────────────────────────────────────────────────────────
  {
    file: 'src/workers/clerk-metadata-backfill-sweep.ts', fn: 'runClerkMetadataBackfillSweep', access: 'pool.query', count: 1,
    category: 'cross_tenant_intentional', tables: ['users'], migrateBy: 'audit 2026-10-23 §4 P3.1',
    why: 'Leader sweep reads users across tenants to backfill Clerk publicMetadata from each row (audit F10 on multi-membership). Raw pool, unattributed; should use the cross-tenant role.',
  },
  {
    file: 'src/workers/demo-lease-reaper.ts', fn: 'runDemoLeaseReaperSweep', access: 'pool.query', count: 2,
    category: 'global_table', tables: ['demo_tenant_leases'],
    why: 'The reaper scans and takes over stale leases on demo_tenant_leases, an RLS-exempt platform table (runtime role revoked); ids only.',
  },
  {
    file: 'src/workers/dunning-sweep.ts', fn: 'runDunningSweep', access: 'pool.query', count: 1,
    category: 'global_table', tables: ['tenants'],
    why: "Past-due scan of the tenants registry (no RLS); each email goes to that tenant's own owner.",
  },
  {
    file: 'src/workers/geocode-locations-sweep.ts', fn: 'listPendingLocations', access: 'pool.connect', count: 1,
    category: 'cross_tenant_intentional', tables: ['service_locations', 'tenants'], handsOffTo: ['clearTenantContext'],
    why: 'Cross-tenant read of the oldest pending service_locations, already under BEGIN + applyCrossTenantRole (rls_cross_tenant); writes go back per row through tenantQuery with that row’s tenant.',
  },
  {
    file: 'src/workers/leader-tick.ts', fn: 'runLeaderGatedTick', access: 'pool.connect', count: 1,
    category: 'global_table', tables: [], handsOffTo: ['watchSessionLease', 'watchSessionLease > <closure>'],
    why: "Dedicated lockPool client for the leader pg_try_advisory_lock / pg_advisory_unlock only (watchSessionLease listens on its error/end; its stopWatching closure detaches them); no table. The work itself runs separately.",
  },
  {
    file: 'src/workers/overage-settlement-reconciliation.ts', fn: 'listStaleSettlements', access: 'pool.query', count: 1,
    category: 'cross_tenant_intentional', tables: ['call_usage_settlements', 'tenants'], migrateBy: 'audit 2026-10-23 §4 P3.1',
    why: "Hourly leader sweep: every tenant's pending/failed call_usage_settlements (FORCE RLS) older than the grace window, joined to tenants to skip demo/platform, with deliberately no tenant filter. Raw pool, so unattributed.",
  },
  {
    file: 'src/workers/overage-settlement-reconciliation.ts', fn: 'listGapTenants', access: 'pool.query', count: 1,
    category: 'global_table', tables: ['tenants'],
    why: 'Subscribed, non-demo starter/growth tenants with a mirrored billing period, from the tenants registry (no tenant_id column, no RLS); ids and period columns only.',
  },
  {
    file: 'src/workers/overage-settlement-reconciliation.ts', fn: 'runOverageSettlementReconciliation', access: 'pool.query', count: 1,
    category: 'tenant_filtered_no_rls', tables: ['call_usage_settlements'], migrateBy: 'audit 2026-10-23 §4 P2.7',
    why: "The gap backfill's covering-settlement read: call_usage_settlements WHERE tenant_id = $1 (a listGapTenants row) on the raw pool, as the principal; the tenant predicate is the only boundary.",
  },
  {
    file: 'src/workers/payment-link-reconciliation-sweep.ts', fn: 'listCollectOnSiteTenantIds', access: 'pool.connect', count: 1,
    category: 'cross_tenant_intentional', tables: ['tenant_settings', 'tenants'], handsOffTo: ['clearTenantContext'],
    why: 'Keyset-paged cross-tenant enumeration of collect-on-site tenant ids under BEGIN + applyCrossTenantRole; returns ids only, which then drive per-tenant work.',
  },
  {
    file: 'src/workers/provision-twilio.ts', fn: 'tryWithTenantPhoneLock', access: 'pool.connect', count: 1,
    category: 'global_table', tables: [],
    why: 'A dedicated client that only takes and releases pg_try_advisory_lock(hashtext(tenant)); all tenant work inside fn() goes through tenantQuery.',
  },
  {
    file: 'src/workers/review-request-worker.ts', fn: 'runReviewRequestSweep', access: 'pool.query', count: 1,
    category: 'cross_tenant_intentional', tables: ['jobs', 'tenant_settings'], migrateBy: 'audit 2026-10-23 §4 P3.1',
    why: "Cross-tenant review-request eligibility scan joining jobs to tenant_settings on tenant_id; each row's own tenant drives the follow-up. Raw pool, so unattributed.",
  },
  {
    file: 'src/workers/setup-reminder-sweep.ts', fn: 'runSetupReminderSweep', access: 'pool.query', count: 1,
    category: 'cross_tenant_intentional', tables: ['tenants', 'lifecycle_emails', 'tenant_settings'], migrateBy: 'audit 2026-10-23 §4 P3.1',
    why: "Cross-tenant setup-reminder candidates: tenants LEFT JOIN lifecycle_emails / tenant_settings on t.id; handleCandidate then uses each row's tenant. Raw pool, unattributed.",
  },
  {
    file: 'src/workers/thank-you-sms-worker.ts', fn: 'runThankYouSmsSweep', access: 'pool.query', count: 1,
    category: 'cross_tenant_intentional', tables: ['jobs', 'tenant_settings'], migrateBy: 'audit 2026-10-23 §4 P3.1',
    why: "Cross-tenant thank-you eligibility scan (jobs JOIN tenant_settings ON tenant_id); every follow-up uses the row's own tenant through repositories and withSendClaim. Raw pool, unattributed.",
  },
  {
    file: 'src/workers/trial-reminder-sweep.ts', fn: 'runTrialReminderSweep', access: 'pool.query', count: 1,
    category: 'global_table', tables: ['tenants'],
    why: "Trial-ending scan of the tenants registry (no RLS); each email goes to that tenant's own owner_email.",
  },
  {
    file: 'src/workers/verify-ai.ts', fn: 'createVerifyAiWorker.handle', access: 'pool.query', count: 5,
    category: 'tenant_filtered_no_rls', tables: ['tenant_settings'], migrateBy: 'audit 2026-10-23 §4 P1.9',
    why: 'The LLM verification worker reads and updates tenant_settings WHERE tenant_id = $1 with the server-set payload tenant (Stripe-resolved or req.auth retry), on the raw pool. One withTenantSession per stage.',
  },
];
