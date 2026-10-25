/**
 * The Stripe `customer.subscription.*` AI-model seed in src/webhooks/routes.ts
 * (raw-pg audit 2026-10-23 §4 P1.10): once billing is live, the tenant's
 * tenant_settings.ai_model is seeded from AI_DEFAULT_MODEL and the onboarding
 * AI self-check is enqueued. The seed UPDATE runs in a tenant session of its
 * own (BEGIN, the tenant GUC + role, the UPDATE, COMMIT), committed before the
 * verify job is enqueued; the tenants-registry lookups around it stay plain
 * pool reads (no RLS on the registry). Real Postgres: see
 * test/integration/stripe-ai-model-seed-tenant-context.test.ts.
 */
import express from 'express';
import request from 'supertest';
import { describe, it, expect, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';

import { createWebhookRouter } from '../../src/webhooks/routes';
import { createWebhookSignature } from '../../src/webhooks/webhook-handler';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { VERIFY_AI_JOB_TYPE } from '../../src/workers/verify-ai';
import { fakeTenantPool } from '../helpers/fake-tenant-pool';

const STRIPE_SECRET = 'whsec_test_ai_model_seed';
const TENANT = '44444444-4444-4444-8444-444444444444';
const MODEL = 'gpt-4o-mini';

function buildApp(config: { AI_DEFAULT_MODEL?: string }) {
  const fake = fakeTenantPool(() => ({ rowCount: 1, rows: [{ id: TENANT }] }));
  const sent: Array<{ type: string; atStatement: number }> = [];
  const send = vi.fn(async (type: string) => {
    sent.push({ type, atStatement: fake.statements.length });
    return `job-${sent.length}`;
  });
  const app = express();
  app.use('/webhooks/stripe', express.raw({ type: '*/*' }));
  app.use(
    '/webhooks',
    createWebhookRouter(config as never, {
      billingService: { applySubscriptionEvent: vi.fn(async () => undefined) } as never,
      pool: fake.pool,
      queue: { send } as never,
      auditRepo: new InMemoryAuditRepository(),
      stripeWebhookSecret: STRIPE_SECRET,
    }),
  );
  return { app, fake, sent };
}

async function postSubscription(app: express.Express, status: string) {
  const raw = JSON.stringify({
    id: `evt_${uuidv4()}`,
    type: 'customer.subscription.created',
    data: { object: { id: 'sub_1', customer: 'cus_1', status } },
  });
  return request(app)
    .post('/webhooks/stripe')
    .set('stripe-signature', createWebhookSignature(raw, STRIPE_SECRET))
    .set('content-type', 'application/json')
    .send(raw);
}

describe('Stripe subscription AI-model seed — its own tenant session', () => {
  it('seeds tenant_settings.ai_model in BEGIN, the tenant context, the UPDATE, COMMIT on one checkout, before the verify job', async () => {
    const { app, fake, sent } = buildApp({ AI_DEFAULT_MODEL: MODEL });

    const res = await postSubscription(app, 'trialing');

    expect(res.status).toBe(200);
    const seedAt = fake.statements.findIndex((st) => /UPDATE tenant_settings/.test(st.sql));
    expect(seedAt).toBeGreaterThan(-1);
    const seed = fake.statements[seedAt]!;
    expect(seed.values).toEqual([TENANT, MODEL]);
    const session = fake.statements.filter((st) => st.checkout === seed.checkout);
    expect(session.map((st) => st.sql.trim().split(/\s+/)[0])).toEqual(['BEGIN', 'SELECT', 'UPDATE', 'COMMIT']);
    expect(session[1]!.sql).toMatch(/set_config\('app\.current_tenant_id', \$1, true\)/);
    expect(session[1]!.values).toEqual([TENANT]);
    // The verify job goes out after the seed's COMMIT.
    const verify = sent.find((s) => s.type === VERIFY_AI_JOB_TYPE);
    expect(verify?.atStatement).toBeGreaterThan(fake.statements.indexOf(session[3]!));
    expect(fake.open()).toBe(0);
  });

  it('the registry lookups stay plain pool reads: the only tenant session in the event is the seed', async () => {
    const { app, fake } = buildApp({ AI_DEFAULT_MODEL: MODEL });

    await postSubscription(app, 'active');

    const contexts = fake.statements.filter((st) => /set_config\('app\.current_tenant_id'/.test(st.sql));
    expect(contexts).toHaveLength(1);
    expect(fake.statements.filter((st) => /tenant_settings/.test(st.sql))).toHaveLength(1);
  });

  it('without AI_DEFAULT_MODEL no tenant_settings statement and no tenant session run; the verify job is still enqueued', async () => {
    const { app, fake, sent } = buildApp({});

    const res = await postSubscription(app, 'trialing');

    expect(res.status).toBe(200);
    expect(fake.statements.filter((st) => /tenant_settings|set_config/.test(st.sql))).toEqual([]);
    expect(sent.map((s) => s.type)).toContain(VERIFY_AI_JOB_TYPE);
  });
});
