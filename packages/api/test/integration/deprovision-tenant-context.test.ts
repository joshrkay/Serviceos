/**
 * Postgres integration — deprovision's Twilio credential read runs under the
 * RLS runtime role (raw-pg audit 2026-10-23 §4 P2.8).
 *
 * Before releasing a tenant's Twilio subaccount, deprovisionTenant reads the
 * tenant's twilio tenant_integrations row (subaccount SID, encrypted token,
 * number SID). readTwilioIntegration set only `app.current_tenant_id` with a
 * hand-written set_config inside its own BEGIN, with no role, so the policy
 * did not bind the privileged principal and `WHERE tenant_id = $1` was the
 * only boundary — on the read whose answer decides which subaccount gets
 * closed. With RLS_RUNTIME_ROLE on, this suite proves:
 *
 *   1. the credential read reports `rls_app_runtime` with the tenant's GUC;
 *   2. with the tenant pin widened to both seeded tenants, RLS alone keeps
 *      the other tenant's subaccount out: deprovisioning a tenant with no
 *      Twilio row releases nothing;
 *   3. control: the same widened read as the connection principal hands the
 *      other tenant's subaccount to closeSubaccount;
 *   4. the role keeps SELECT on tenant_integrations after migration 219;
 *   5. the order and failure behaviour are kept: the SID is read and released
 *      before the purge, and a Twilio failure on the manual path aborts with
 *      the tenant's rows still in place;
 *   6. the cost: the read is still one checkout of four statements (BEGIN,
 *      the context, the read, COMMIT); the context statement now also sets
 *      the role.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import type { Pool } from 'pg';
import { closeSharedTestDb, createTestTenant, getSharedTestDb, TENANT_CONTEXT_WITH_ROLE_SQL } from './shared';
import { probeStatementRoles } from './statement-role-probe';
import { countPoolTraffic, runtimeRoleGrantsMissingAfter219, widenTenantPredicates } from './tenant-predicate-probe';
import { deprovisionTenant } from '../../src/tenants/deprovision';
import { encrypt } from '../../src/integrations/crypto';
import { createLogger } from '../../src/logging/logger';

const ORIGINAL_ENV = { ...process.env };
const ENC_KEY = '0011223344556677889900112233445566778899001122334455667788990011';
const CREDENTIAL = /SELECT subaccount_sid, auth_token_primary_enc, provider_data/;
const logger = createLogger({ service: 'test', environment: 'test', level: 'error' });

let pool: Pool;
const tenantIds: string[] = [];

async function seedTenant(opts: { twilio?: boolean } = {}): Promise<{ tenantId: string; subaccountSid: string | null }> {
  const { tenantId } = await createTestTenant(pool);
  tenantIds.push(tenantId);
  if (!opts.twilio) return { tenantId, subaccountSid: null };
  const subaccountSid = `AC${crypto.randomUUID().replace(/-/g, '')}`;
  await pool.query(
    `INSERT INTO tenant_integrations (tenant_id, provider, status, subaccount_sid, auth_token_primary_enc, provider_data)
     VALUES ($1, 'twilio', 'full_readiness', $2, $3, $4::jsonb)`,
    [tenantId, subaccountSid, encrypt('sub-auth-token', ENC_KEY), JSON.stringify({ phoneNumberSid: `PN${tenantId.slice(0, 8)}` })],
  );
  return { tenantId, subaccountSid };
}

function twilioMock() {
  return {
    releasePhoneNumber: vi.fn(async () => undefined),
    closeSubaccount: vi.fn(async () => undefined),
  };
}

async function tenantExists(tenantId: string): Promise<boolean> {
  const { rows } = await pool.query('SELECT 1 FROM tenants WHERE id = $1', [tenantId]);
  return rows.length === 1;
}

async function twilioRows(tenantId: string): Promise<number> {
  const { rows } = await pool.query(`SELECT 1 FROM tenant_integrations WHERE tenant_id = $1 AND provider = 'twilio'`, [tenantId]);
  return rows.length;
}

beforeAll(async () => {
  pool = await getSharedTestDb();
});

beforeEach(() => {
  process.env.RLS_RUNTIME_ROLE = 'true';
  process.env.TENANT_ENCRYPTION_KEY = ENC_KEY;
  process.env.TWILIO_ACCOUNT_SID = 'ACmaster';
  process.env.TWILIO_AUTH_TOKEN = 'master-token';
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

afterAll(async () => {
  for (const id of tenantIds) {
    for (const table of ['tenant_integrations', 'audit_events', 'users']) {
      await pool.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [id]).catch(() => undefined);
    }
    await pool.query('DELETE FROM platform_deprovision_log WHERE tenant_id = $1', [id]).catch(() => undefined);
    await pool.query('DELETE FROM tenants WHERE id = $1', [id]).catch(() => undefined);
  }
  await closeSharedTestDb();
});

describe('deprovision — the Twilio credential read under the RLS runtime role (real Postgres)', () => {
  it('reads the tenant\'s own twilio row as rls_app_runtime with its GUC, and releases that subaccount', async () => {
    const t = await seedTenant({ twilio: true });
    const probe = probeStatementRoles(pool, CREDENTIAL);
    const twilio = twilioMock();

    const result = await deprovisionTenant({ pool: probe.pool, logger, twilio }, { tenantId: t.tenantId, reason: 'manual_admin', actorId: 'admin' });

    expect(result).toMatchObject({ alreadyPurged: false, twilioReleased: true });
    expect(twilio.closeSubaccount).toHaveBeenCalledWith('ACmaster', 'master-token', t.subaccountSid);
    expect(probe.seen).toEqual([expect.objectContaining({ role: 'rls_app_runtime', tenantGuc: t.tenantId })]);
  });
});

describe('deprovision — RLS alone keeps another tenant\'s subaccount out of the release (real Postgres)', () => {
  /** The caller has no Twilio row; the other tenant has one. */
  async function runWidened(asPrincipal: boolean) {
    const caller = await seedTenant();
    const other = await seedTenant({ twilio: true });
    const widened = widenTenantPredicates(pool, { target: CREDENTIAL, tenants: [caller.tenantId, other.tenantId], asPrincipal });
    const twilio = twilioMock();

    const result = await deprovisionTenant(
      { pool: widened.pool, logger, twilio },
      { tenantId: caller.tenantId, reason: 'stripe_subscription_deleted', actorId: 'stripe' },
    );

    expect(widened.rewritten).toHaveLength(1);
    expect(await tenantExists(caller.tenantId)).toBe(false);
    expect(await twilioRows(other.tenantId)).toBe(1);
    return { result, closed: twilio.closeSubaccount.mock.calls.map((c) => (c as unknown[])[2]), otherSid: other.subaccountSid };
  }

  it('with the tenant pin widened to both tenants, nothing is released', async () => {
    const r = await runWidened(false);
    expect(r.closed).toEqual([]);
    expect(r.result).toMatchObject({ twilioReleased: false });
    expect(r.result.twilioError).toBeUndefined();
  });

  it('control: the same widened read as the connection principal closes the OTHER tenant\'s subaccount', async () => {
    const r = await runWidened(true);
    expect(r.closed).toEqual([r.otherSid]);
  });
});

describe('grants: rls_app_runtime keeps what the credential read needs after migration 219', () => {
  it('tenant_integrations stays readable', async () => {
    expect(await runtimeRoleGrantsMissingAfter219(pool, [['tenant_integrations', 'SELECT']])).toEqual([]);
  });
});

describe('deprovision — order and failure behaviour kept (real Postgres)', () => {
  it('the SID is read and released before the purge; then every row, the tenant, and the durable log', async () => {
    const t = await seedTenant({ twilio: true });
    const twilio = twilioMock();
    let rowsAtRelease = -1;
    twilio.closeSubaccount.mockImplementation(async () => {
      rowsAtRelease = await twilioRows(t.tenantId);
    });

    const result = await deprovisionTenant({ pool, logger, twilio }, { tenantId: t.tenantId, reason: 'manual_admin', actorId: 'admin' });

    expect(rowsAtRelease).toBe(1);
    expect(result.rowsDeletedByTable).toMatchObject({ tenant_integrations: 1, tenants: 1 });
    expect(await tenantExists(t.tenantId)).toBe(false);
    const { rows } = await pool.query(
      'SELECT twilio_released, twilio_subaccount_sid FROM platform_deprovision_log WHERE tenant_id = $1',
      [t.tenantId],
    );
    expect(rows).toEqual([{ twilio_released: true, twilio_subaccount_sid: t.subaccountSid }]);
  });

  it('a Twilio failure on the manual path aborts before the purge: the tenant and its Twilio row stay', async () => {
    const t = await seedTenant({ twilio: true });
    const twilio = twilioMock();
    twilio.closeSubaccount.mockRejectedValue(new Error('twilio 500'));

    await expect(
      deprovisionTenant({ pool, logger, twilio }, { tenantId: t.tenantId, reason: 'manual_admin', actorId: 'admin' }),
    ).rejects.toThrow(/Twilio release failed/);

    expect(await tenantExists(t.tenantId)).toBe(true);
    expect(await twilioRows(t.tenantId)).toBe(1);
  });
});

describe('deprovision — cost (real Postgres, RLS_RUNTIME_ROLE=true)', () => {
  it('the credential read is still one checkout of four statements, and the deprovision never holds two connections (base: the same 4 checkouts)', async () => {
    const t = await seedTenant({ twilio: true });
    const traffic = countPoolTraffic(pool);

    await deprovisionTenant({ pool: traffic.pool, logger, twilio: twilioMock() }, { tenantId: t.tenantId, reason: 'manual_admin', actorId: 'admin' });

    expect({ checkouts: traffic.checkouts(), maxOpen: traffic.maxOpen() }).toEqual({ checkouts: 4, maxOpen: 1 });
    const ran = traffic.statements();
    expect(ran[0]).toMatch(/^SELECT id FROM tenants WHERE id = \$1/);
    expect(ran.slice(1, 5).map((s) => s.replace(/\s+/g, ' ').trim())).toEqual([
      'BEGIN',
      TENANT_CONTEXT_WITH_ROLE_SQL,
      expect.stringMatching(CREDENTIAL),
      'COMMIT',
    ]);
    expect(ran[5]).toBe('BEGIN');
    expect(ran[6]).toMatch(/session_replication_role/);
  });
});
