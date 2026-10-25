/**
 * Postgres integration — the billing owner-email lookup runs under the RLS
 * runtime role (raw-pg audit 2026-10-23 §4 P2.3).
 *
 * resolveOwnerEmail ran `users WHERE tenant_id = $1 AND clerk_user_id = $2`
 * (falling back to `tenants.owner_email`) on the raw pool as the privileged
 * principal, a second pooled connection next to the request's. With
 * RLS_RUNTIME_ROLE on, this suite proves:
 *
 *   1. the lookup reports `rls_app_runtime` with the request tenant's GUC;
 *   2. with the users subquery's tenant pin widened to both tenants, RLS alone
 *      keeps another tenant's membership row for the same Clerk subject out,
 *      so the lookup falls back to the caller's own tenants.owner_email;
 *   3. control: the same widened lookup as the connection principal returns
 *      the other tenant's member email;
 *   4. the role keeps SELECT on users and tenants after migration 219;
 *   5. each of its three callers — POST /api/onboarding/billing/
 *      checkout-session, POST /api/billing/portal-session, POST /api/billing/
 *      connect/onboarding — runs it on the request transaction's client: no
 *      second checkout, one statement, never two connections at once.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import express from 'express';
import request from 'supertest';
import type { Pool } from 'pg';
import { closeSharedTestDb, createTestTenant, getSharedTestDb, TENANT_CONTEXT_WITH_ROLE_SQL } from './shared';
import { probeStatementRoles } from './statement-role-probe';
import { countPoolTraffic, runtimeRoleGrantsMissingAfter219, widenTenantPredicates } from './tenant-predicate-probe';
import { resolveOwnerEmail } from '../../src/auth/resolve-owner-email';
import type { AuthenticatedRequest } from '../../src/auth/clerk';
import { withTenantTransaction } from '../../src/middleware/tenant-context';
import { clearUserModeCacheForTests, setUserModeLoader } from '../../src/middleware/auth';
import { createBillingRouter } from '../../src/routes/billing';
import { createOnboardingRouter } from '../../src/routes/onboarding';
import type { BillingService } from '../../src/billing/subscription';
import type { StripeConnectService } from '../../src/billing/stripe-connect';
import { InMemorySettingsRepository } from '../../src/settings/settings';
import { InMemoryPackActivationRepository } from '../../src/settings/pack-activation';
import { InMemoryAuditRepository } from '../../src/audit/audit';

const ORIGINAL_FLAG = process.env.RLS_RUNTIME_ROLE;
const LOOKUP = /SELECT COALESCE\(/;

let pool: Pool;
const tenantIds: string[] = [];

/** A tenant whose owner_email is `owner-<tenant>@example.com`, with no users row for `clerk` unless `memberEmail`. */
async function seedTenant(clerk: string, memberEmail?: string): Promise<{ tenantId: string; ownerEmail: string }> {
  const { tenantId } = await createTestTenant(pool);
  tenantIds.push(tenantId);
  const ownerEmail = `owner-${tenantId}@example.com`;
  await pool.query(`UPDATE tenants SET owner_email = $2 WHERE id = $1`, [tenantId, ownerEmail]);
  if (memberEmail) {
    await pool.query(
      `INSERT INTO users (id, tenant_id, clerk_user_id, email, role) VALUES ($1, $2, $3, $4, 'owner')`,
      [crypto.randomUUID(), tenantId, clerk, memberEmail],
    );
  }
  return { tenantId, ownerEmail };
}

const authed = (tenantId: string, clerk: string) =>
  ({ auth: { userId: clerk, sessionId: 's', tenantId, role: 'owner' } }) as AuthenticatedRequest;

beforeAll(async () => {
  pool = await getSharedTestDb();
});

beforeEach(() => {
  process.env.RLS_RUNTIME_ROLE = 'true';
  // requireTenant's mode read is measured in user-mode-tenant-context.test.ts.
  setUserModeLoader(null);
  clearUserModeCacheForTests();
});

afterEach(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env.RLS_RUNTIME_ROLE;
  else process.env.RLS_RUNTIME_ROLE = ORIGINAL_FLAG;
});

afterAll(async () => {
  for (const id of tenantIds) {
    await pool.query(`DELETE FROM users WHERE tenant_id = $1`, [id]).catch(() => undefined);
    await pool.query('DELETE FROM tenants WHERE id = $1', [id]).catch(() => undefined);
  }
  await closeSharedTestDb();
});

describe('resolveOwnerEmail — under the RLS runtime role (real Postgres)', () => {
  it("off-request it is one tenant session, the lookup as rls_app_runtime with the tenant's GUC: the member email, then tenants.owner_email", async () => {
    const clerk = `user_owner_${crypto.randomUUID()}`;
    const member = await seedTenant(clerk, `member-${clerk}@example.com`);
    const noMember = await seedTenant(clerk);
    const probe = probeStatementRoles(pool, LOOKUP);

    expect(await resolveOwnerEmail(authed(member.tenantId, clerk), probe.pool)).toBe(`member-${clerk}@example.com`);
    expect(await resolveOwnerEmail(authed(noMember.tenantId, clerk), probe.pool)).toBe(noMember.ownerEmail);

    expect(probe.seen).toEqual([
      expect.objectContaining({ role: 'rls_app_runtime', tenantGuc: member.tenantId }),
      expect.objectContaining({ role: 'rls_app_runtime', tenantGuc: noMember.tenantId }),
    ]);
  });

  async function widenedLookup(asPrincipal: boolean) {
    const clerk = `user_owner_${crypto.randomUUID()}`;
    const caller = await seedTenant(clerk);
    const other = await seedTenant(clerk, `other-member-${clerk}@example.com`);
    const widened = widenTenantPredicates(pool, { target: LOOKUP, tenants: [caller.tenantId, other.tenantId], asPrincipal });

    const email = await resolveOwnerEmail(authed(caller.tenantId, clerk), widened.pool);

    expect(widened.rewritten).toHaveLength(1);
    return { email, callerOwner: caller.ownerEmail, otherMember: `other-member-${clerk}@example.com` };
  }

  it("with the users pin widened to both tenants, RLS keeps the other tenant's member row out: the caller's own owner_email", async () => {
    const r = await widenedLookup(false);
    expect(r.email).toBe(r.callerOwner);
  });

  it("control: the same widened lookup as the connection principal answers with the other tenant's member email", async () => {
    const r = await widenedLookup(true);
    expect(r.email).toBe(r.otherMember);
  });

  it('grants: rls_app_runtime keeps SELECT on users and tenants after migration 219', async () => {
    expect(await runtimeRoleGrantsMissingAfter219(pool, [['users', 'SELECT'], ['tenants', 'SELECT']])).toEqual([]);
  });
});

describe('resolveOwnerEmail callers — on the request transaction\'s client (real Postgres)', () => {
  /** The /api order of app.ts: the verified session (stubbed), the request transaction, the routers. */
  function buildApp(traffic: ReturnType<typeof countPoolTraffic>, tenantId: string, clerk: string, seen: string[]) {
    const billingService = {
      createTrialCheckoutSession: async (input: { ownerEmail: string }) => {
        seen.push(input.ownerEmail);
        return { url: 'https://checkout.stripe.test/session' };
      },
      getOrCreatePortalUrl: async (input: { ownerEmail: string }) => {
        seen.push(input.ownerEmail);
        return { url: 'https://billing.stripe.test/portal' };
      },
    } as unknown as BillingService;
    const connectService = {
      createOnboardingLink: async (input: { ownerEmail: string }) => {
        seen.push(input.ownerEmail);
        return { url: 'https://connect.stripe.test/onboarding' };
      },
    } as unknown as StripeConnectService;
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as AuthenticatedRequest).auth = { userId: clerk, sessionId: 'sess-billing', tenantId, role: 'owner' };
      next();
    });
    app.use('/api', withTenantTransaction(traffic.pool));
    app.use('/api/billing', createBillingRouter({ billingService, connectService, pool: traffic.pool }));
    app.use(
      '/api/onboarding',
      createOnboardingRouter({
        settingsRepo: new InMemorySettingsRepository(),
        packActivationRepo: new InMemoryPackActivationRepository(),
        auditRepo: new InMemoryAuditRepository(),
        pool: traffic.pool,
        billingService,
      }),
    );
    return app;
  }

  const routes: Array<[string, string, object]> = [
    ['POST /api/onboarding/billing/checkout-session', '/api/onboarding/billing/checkout-session', { planId: 'starter' }],
    ['POST /api/billing/portal-session', '/api/billing/portal-session', { returnUrl: 'https://app.example.com/settings' }],
    [
      'POST /api/billing/connect/onboarding',
      '/api/billing/connect/onboarding',
      { returnUrl: 'https://app.example.com/settings', refreshUrl: 'https://app.example.com/settings?retry=1' },
    ],
  ];

  for (const [name, path, body] of routes) {
    it(`${name}: the lookup is one statement on the request client (base: 2 checkouts / 5 statements, 2 open at once)`, async () => {
      const clerk = `user_owner_${crypto.randomUUID()}`;
      const t = await seedTenant(clerk, `member-${clerk}@example.com`);
      const traffic = countPoolTraffic(pool);
      const seen: string[] = [];

      const res = await request(buildApp(traffic, t.tenantId, clerk, seen)).post(path).send(body);

      expect(res.status).toBe(200);
      expect(seen).toEqual([`member-${clerk}@example.com`]);
      expect({ checkouts: traffic.checkouts(), statements: traffic.statements().length, maxOpen: traffic.maxOpen() }).toEqual({
        checkouts: 1,
        statements: 5,
        maxOpen: 1,
      });
      const ran = traffic.statements();
      expect(ran[0]).toBe('BEGIN');
      expect(ran[1]).toBe(TENANT_CONTEXT_WITH_ROLE_SQL);
      expect(ran[3]).toMatch(LOOKUP);
      expect(ran[4]).toBe('COMMIT');
    });
  }
});
