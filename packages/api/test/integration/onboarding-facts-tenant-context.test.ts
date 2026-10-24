/**
 * Postgres integration — loadOnboardingFacts' raw reads run under the RLS
 * runtime role off-request too (raw-pg audit 2026-10-23 §4 P1.11).
 *
 * `db = currentTenantContext()?.client ?? pool`: inside GET
 * /api/onboarding/status and POST /api/onboarding/test-call/skip the reads ran
 * on the RLS request client, but its callers without a request (the
 * setup-reminder sweep and scripts/provision-tenant.ts) fell back to the raw
 * pool, where its seven reads of tenant_integrations, tenants, voice_sessions,
 * tenant_settings, pack_activations, onboarding_drafts and proposals rested on
 * `WHERE tenant_id = $1` alone. They now take one tenant session of their own. With
 * RLS_RUNTIME_ROLE on, this suite proves:
 *
 *   1. off-request, every fact read (the approved draft's proposals read
 *      included) reports `rls_app_runtime` with the tenant's GUC;
 *   2. with the tenant pin widened to both seeded tenants, RLS alone keeps the
 *      other tenant's integration, calls, settings, packs, draft and proposals
 *      out of the facts;
 *   3. control: the same widened reads as the connection principal see them;
 *   4. the role keeps SELECT on all seven tables after migration 219;
 *   5. inside a request for the tenant the reads ride the request client (no
 *      checkout), as before;
 *   6. the sweep's cost per tenant against base: fewer connections, never two
 *      at once.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { closeSharedTestDb, createTestTenant, getSharedTestDb } from './shared';
import { probeStatementRoles } from './statement-role-probe';
import { countPoolTraffic, runtimeRoleGrantsMissingAfter219, widenTenantPredicates } from './tenant-predicate-probe';
import { loadOnboardingFacts } from '../../src/onboarding/load-facts';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { applyTenantContext } from '../../src/db/rls-runtime-role';
import { tenantContextStore } from '../../src/middleware/tenant-context';

const ORIGINAL_FLAG = process.env.RLS_RUNTIME_ROLE;
/** The fact reads' tables (the settings repository's own read matches tenant_settings too). */
const FACTS = /tenant_integrations|FROM tenants\b|voice_sessions|tenant_settings|pack_activations|onboarding_drafts|FROM proposals/;
/** The fact reads with a `tenant_id = $n` pin (the tenants registry read is by id). */
const PINNED = /tenant_integrations|voice_sessions|FROM tenant_settings|pack_activations|onboarding_drafts|FROM proposals/;

let pool: Pool;
const tenantIds: string[] = [];

/** A tenant with every fact present (`full`), or a bare one. */
async function seedTenant(full: boolean): Promise<string> {
  const { tenantId, userId } = await createTestTenant(pool);
  tenantIds.push(tenantId);
  if (!full) return tenantId;
  await pool.query(
    `INSERT INTO tenant_integrations (tenant_id, provider, status, last_error, provider_data)
     VALUES ($1, 'twilio', 'full_readiness', NULL, '{"phoneNumber": "+15125550188"}'::jsonb)`,
    [tenantId],
  );
  await pool.query(
    `INSERT INTO voice_sessions (tenant_id, channel, state, ended_at) VALUES ($1, 'voice_inbound', 'ended', NOW()), ($1, 'voice_inbound', 'ended', NOW())`,
    [tenantId],
  );
  await pool.query(
    `INSERT INTO tenant_settings (tenant_id, business_name, timezone, ai_model) VALUES ($1, 'Facts Shop', 'America/Chicago', 'gpt-4o-mini')`,
    [tenantId],
  );
  await pool.query(`INSERT INTO pack_activations (tenant_id, pack_id, status) VALUES ($1, 'plumbing', 'active')`, [tenantId]);
  const proposals: string[] = [];
  for (let i = 0; i < 2; i++) {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO proposals (tenant_id, proposal_type, status, payload, created_by, approved_at)
       VALUES ($1, 'onboarding_voice_policy', 'executed', '{}'::jsonb, $2, NOW()) RETURNING id`,
      [tenantId, userId],
    );
    proposals.push(rows[0]!.id);
  }
  await pool.query(
    `INSERT INTO onboarding_drafts (tenant_id, pack_id, trade, business_name, assembled, choices, status, proposal_ids)
     VALUES ($1, 'plumbing', 'plumbing', 'Facts Shop', '{}'::jsonb, '{"a": 1, "b": 2}'::jsonb, 'approved', $2::jsonb)`,
    [tenantId, JSON.stringify(proposals)],
  );
  return tenantId;
}

/** The facts the other tenant's rows would move, read back. */
async function factsOf(p: Pool, tenantId: string) {
  const f = await loadOnboardingFacts({ pool: p, settingsRepo: new PgSettingsRepository(pool) }, tenantId);
  return {
    twilioStatus: f.twilioStatus,
    inboundCallCount: f.inboundCallCount,
    timezone: f.identity.timezone,
    aiConfigPresent: f.aiConfigPresent,
    packActivated: f.packActivated,
    draft: f.draft ? { status: f.draft.status, choicesAnswered: f.draft.choicesAnswered, members: f.draft.proposals?.members.length } : null,
  };
}

const NOTHING = { twilioStatus: null, inboundCallCount: 0, timezone: null, aiConfigPresent: false, packActivated: false, draft: null };
const EVERYTHING = {
  twilioStatus: 'full_readiness',
  inboundCallCount: 2,
  timezone: 'America/Chicago',
  aiConfigPresent: true,
  packActivated: true,
  draft: { status: 'approved', choicesAnswered: 2, members: 2 },
};

beforeAll(async () => {
  pool = await getSharedTestDb();
});

beforeEach(() => {
  process.env.RLS_RUNTIME_ROLE = 'true';
});

afterEach(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env.RLS_RUNTIME_ROLE;
  else process.env.RLS_RUNTIME_ROLE = ORIGINAL_FLAG;
});

afterAll(async () => {
  for (const id of tenantIds) {
    for (const table of ['onboarding_drafts', 'proposals', 'pack_activations', 'tenant_settings', 'voice_sessions', 'tenant_integrations', 'users']) {
      await pool.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [id]).catch(() => undefined);
    }
    await pool.query('DELETE FROM tenants WHERE id = $1', [id]).catch(() => undefined);
  }
  await closeSharedTestDb();
});

describe('loadOnboardingFacts off-request (the setup-reminder sweep) — under the RLS runtime role (real Postgres)', () => {
  it("reads its own tenant's facts, every fact read — the approved draft's proposals included — as rls_app_runtime", async () => {
    const tenantId = await seedTenant(true);
    const probe = probeStatementRoles(pool, FACTS);

    expect(await factsOf(probe.pool, tenantId)).toEqual(EVERYTHING);

    // Six reads, then the approved draft's proposals read.
    expect(probe.seen).toHaveLength(7);
    for (const s of probe.seen) expect(s).toMatchObject({ role: 'rls_app_runtime', tenantGuc: tenantId });
  });

  it("with the tenant pin widened to both tenants, RLS alone keeps the other tenant's facts out", async () => {
    const caller = await seedTenant(false);
    const other = await seedTenant(true);
    const widened = widenTenantPredicates(pool, { target: PINNED, tenants: [caller, other] });

    expect(await factsOf(widened.pool, caller)).toEqual(NOTHING);
    expect(widened.rewritten).toHaveLength(5);
  });

  it("control: the same widened reads run as the connection principal see the other tenant's facts", async () => {
    const caller = await seedTenant(false);
    const other = await seedTenant(true);
    const widened = widenTenantPredicates(pool, { target: PINNED, tenants: [caller, other], asPrincipal: true });

    // The draft is the other tenant's, approved — so its proposals read runs (and is widened) too.
    expect(await factsOf(widened.pool, caller)).toEqual(EVERYTHING);
    expect(widened.rewritten).toHaveLength(6);
  });

  it('grants: rls_app_runtime keeps SELECT on all seven fact tables after migration 219', async () => {
    expect(
      await runtimeRoleGrantsMissingAfter219(pool, [
        ['tenant_integrations', 'SELECT'],
        ['tenants', 'SELECT'],
        ['voice_sessions', 'SELECT'],
        ['tenant_settings', 'SELECT'],
        ['pack_activations', 'SELECT'],
        ['onboarding_drafts', 'SELECT'],
        ['proposals', 'SELECT'],
      ]),
    ).toEqual([]);
  });
});

describe('loadOnboardingFacts inside a request — the request client, as before (real Postgres)', () => {
  it('every read rides the request transaction: no checkout of its own', async () => {
    const tenantId = await seedTenant(true);
    const traffic = countPoolTraffic(pool);
    const client = await pool.connect();
    let facts: Awaited<ReturnType<typeof loadOnboardingFacts>> | undefined;
    try {
      await client.query('BEGIN');
      await applyTenantContext(client, tenantId, { transactional: true });
      facts = await tenantContextStore.run({ client, tenantId }, () =>
        loadOnboardingFacts({ pool: traffic.pool, settingsRepo: new PgSettingsRepository(traffic.pool) }, tenantId),
      );
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }

    expect(traffic.checkouts()).toBe(0);
    expect(facts).toMatchObject({ twilioStatus: 'full_readiness', inboundCallCount: 2, packActivated: true });
  });
});

describe('loadOnboardingFacts — cost per sweep tenant (real Postgres)', () => {
  it('the settings read, then one tenant session for the fact reads; never two connections at once', async () => {
    const measure = async (tenantId: string) => {
      const traffic = countPoolTraffic(pool);
      await loadOnboardingFacts({ pool: traffic.pool, settingsRepo: new PgSettingsRepository(traffic.pool) }, tenantId);
      return { checkouts: traffic.checkouts(), statements: traffic.statements().length, maxOpen: traffic.maxOpen() };
    };

    // Base: the settings repository's session (BEGIN, GUC + role, SELECT,
    // COMMIT, RESET ROLE, RESET GUC: 1 / 6) and six concurrent raw pool
    // reads (6 / 6), the proposals read a seventh: 7 checkouts / 12
    // statements (8 / 13 with an approved draft), several open at once.
    // HEAD: the same settings session, then BEGIN, GUC + role, the reads,
    // COMMIT on one checkout.
    expect(await measure(await seedTenant(false))).toEqual({ checkouts: 2, statements: 15, maxOpen: 1 });
    expect(await measure(await seedTenant(true))).toEqual({ checkouts: 2, statements: 16, maxOpen: 1 });
  });
});
