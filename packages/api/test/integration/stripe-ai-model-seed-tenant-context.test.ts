/**
 * Postgres integration — the Stripe webhook's AI-model seed runs under the
 * RLS runtime role (raw-pg audit 2026-10-23 §4 P1.10).
 *
 * On a `customer.subscription.*` event reaching trialing/active, POST
 * /webhooks/stripe seeds `tenant_settings.ai_model = COALESCE(ai_model,
 * AI_DEFAULT_MODEL)` for the tenant mapped to the event's customer and
 * enqueues the onboarding AI self-check. The UPDATE ran on the raw pool as the
 * privileged principal (`WHERE tenant_id = $1` the only boundary); it now runs
 * in a tenant session of its own. With RLS_RUNTIME_ROLE on, this suite proves,
 * through the real route with a signed event:
 *
 *   1. the seed UPDATE reports `rls_app_runtime` with the mapped tenant's GUC,
 *      seeds a missing model and leaves a chosen one alone;
 *   2. with its tenant pin widened to both seeded tenants, RLS alone keeps the
 *      other tenant's settings row unseeded;
 *   3. control: the same widened UPDATE as the connection principal seeds it;
 *   4. the role keeps SELECT and UPDATE on tenant_settings after migration 219;
 *   5. the event's cost on the route's pool, against base.
 */
import express from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { randomUUID } from 'crypto';

import { closeSharedTestDb, createTestTenant, getSharedTestDb } from './shared';
import { probeStatementRoles } from './statement-role-probe';
import { countPoolTraffic, runtimeRoleGrantsMissingAfter219, widenTenantPredicates } from './tenant-predicate-probe';
import { createWebhookRouter } from '../../src/webhooks/routes';
import { createWebhookSignature } from '../../src/webhooks/webhook-handler';
import { BillingService } from '../../src/billing/subscription';
import { PgWebhookRepository } from '../../src/webhooks/pg-webhook';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { VERIFY_AI_JOB_TYPE } from '../../src/workers/verify-ai';

const ORIGINAL_FLAG = process.env.RLS_RUNTIME_ROLE;
const SECRET = 'whsec_ai_model_seed_tenant_context';
const MODEL = 'gpt-4o-mini';
const SETTINGS = /tenant_settings/;

let pool: Pool;
const tenantIds: string[] = [];

/** A tenant with a settings row (ai_model as given) that a trialing event for `customer` will map. */
async function seedTenant(aiModel: string | null): Promise<{ tenantId: string; customer: string }> {
  const { tenantId } = await createTestTenant(pool);
  tenantIds.push(tenantId);
  await pool.query(`INSERT INTO tenant_settings (tenant_id, business_name, ai_model) VALUES ($1, 'Seed Shop', $2)`, [
    tenantId,
    aiModel,
  ]);
  return { tenantId, customer: `cus_${randomUUID().replace(/-/g, '').slice(0, 14)}` };
}

async function aiModelOf(tenantId: string): Promise<string | null> {
  const { rows } = await pool.query<{ ai_model: string | null }>(`SELECT ai_model FROM tenant_settings WHERE tenant_id = $1`, [
    tenantId,
  ]);
  return rows[0]?.ai_model ?? null;
}

/** The real Stripe route on `routePool`; the webhook and audit repositories stay on the real pool. */
function appOn(routePool: Pool) {
  const sent: Array<{ type: string; payload: unknown }> = [];
  const app = express();
  app.use('/webhooks/stripe', express.raw({ type: '*/*' }));
  app.use(
    '/webhooks',
    createWebhookRouter({ AI_DEFAULT_MODEL: MODEL } as never, {
      billingService: new BillingService({ pool, config: { apiKey: 'sk_test_mock' } }),
      pool: routePool,
      webhookRepo: new PgWebhookRepository(pool),
      auditRepo: new PgAuditRepository(pool),
      queue: {
        send: async (type: string, payload: unknown) => {
          sent.push({ type, payload });
          return `job-${sent.length}`;
        },
      } as never,
      stripeWebhookSecret: SECRET,
    }),
  );
  return { app, sent };
}

async function postTrialing(app: express.Express, t: { tenantId: string; customer: string }) {
  const id = `evt_${randomUUID()}`;
  const raw = JSON.stringify({
    id,
    type: 'customer.subscription.created',
    data: {
      object: {
        id: `sub_${randomUUID().slice(0, 8)}`,
        customer: t.customer,
        status: 'trialing',
        trial_end: Math.floor(Date.now() / 1000) + 14 * 86_400,
        metadata: { tenant_id: t.tenantId },
      },
    },
  });
  return request(app)
    .post('/webhooks/stripe')
    .set('stripe-signature', createWebhookSignature(raw, SECRET))
    .set('content-type', 'application/json')
    .send(raw);
}

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
    for (const table of ['audit_events', 'tenant_settings', 'users']) {
      await pool.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [id]).catch(() => undefined);
    }
    await pool.query('DELETE FROM tenants WHERE id = $1', [id]).catch(() => undefined);
  }
  await closeSharedTestDb();
});

describe('POST /webhooks/stripe — the AI-model seed under the RLS runtime role (real Postgres)', () => {
  it("seeds the mapped tenant's missing model as rls_app_runtime for that tenant, then enqueues its self-check", async () => {
    const t = await seedTenant(null);
    const probe = probeStatementRoles(pool, SETTINGS);
    const { app, sent } = appOn(probe.pool);

    const res = await postTrialing(app, t);

    expect(res.status).toBe(200);
    expect(await aiModelOf(t.tenantId)).toBe(MODEL);
    expect(probe.seen).toHaveLength(1);
    expect(probe.seen[0]).toMatchObject({ role: 'rls_app_runtime', tenantGuc: t.tenantId });
    expect(sent.filter((s) => s.type === VERIFY_AI_JOB_TYPE).map((s) => s.payload)).toEqual([{ tenantId: t.tenantId }]);
  });

  it('leaves a model the tenant already has alone (COALESCE), still as rls_app_runtime', async () => {
    const t = await seedTenant('claude-sonnet');
    const probe = probeStatementRoles(pool, SETTINGS);

    expect((await postTrialing(appOn(probe.pool).app, t)).status).toBe(200);

    expect(await aiModelOf(t.tenantId)).toBe('claude-sonnet');
    expect(probe.seen).toEqual([expect.objectContaining({ role: 'rls_app_runtime', tenantGuc: t.tenantId })]);
  });

  it("with the tenant pin widened to both tenants, RLS alone keeps the other tenant's settings unseeded", async () => {
    const caller = await seedTenant(null);
    const other = await seedTenant(null);
    const widened = widenTenantPredicates(pool, { target: SETTINGS, tenants: [caller.tenantId, other.tenantId] });

    expect((await postTrialing(appOn(widened.pool).app, caller)).status).toBe(200);

    expect(widened.rewritten).toHaveLength(1);
    expect(await aiModelOf(caller.tenantId)).toBe(MODEL);
    expect(await aiModelOf(other.tenantId)).toBeNull();
  });

  it('control: the same widened UPDATE run as the connection principal seeds the other tenant too', async () => {
    const caller = await seedTenant(null);
    const other = await seedTenant(null);
    const widened = widenTenantPredicates(pool, {
      target: SETTINGS,
      tenants: [caller.tenantId, other.tenantId],
      asPrincipal: true,
    });

    expect((await postTrialing(appOn(widened.pool).app, caller)).status).toBe(200);

    expect(widened.rewritten).toHaveLength(1);
    expect(await aiModelOf(other.tenantId)).toBe(MODEL);
  });

  it('grants: tenant_settings stays readable and updatable for rls_app_runtime after migration 219', async () => {
    expect(await runtimeRoleGrantsMissingAfter219(pool, [['tenant_settings', 'SELECT'], ['tenant_settings', 'UPDATE']])).toEqual([]);
  });

  it("cost: the seed is one tenant session; the event's other statements stay on the registry (base: 3 checkouts / 8 statements)", async () => {
    const t = await seedTenant(null);
    const traffic = countPoolTraffic(pool);

    expect((await postTrialing(appOn(traffic.pool).app, t)).status).toBe(200);

    // The subscription mirror transaction (BEGIN, FOR UPDATE, three tenants
    // UPDATEs, COMMIT: 6), the seed's customer lookup (1), the seed session
    // (BEGIN, GUC + role, UPDATE, COMMIT: 4). Base ran the seed as one bare
    // pool.query (6 + 1 + 1): the 3 added statements are the RLS floor.
    expect({ checkouts: traffic.checkouts(), statements: traffic.statements().length, maxOpen: traffic.maxOpen() }).toEqual({
      checkouts: 3,
      statements: 11,
      maxOpen: 1,
    });
    const seed = traffic.statements().filter((s) => SETTINGS.test(s) || /set_config/.test(s));
    expect(seed).toHaveLength(2);
  });
});
