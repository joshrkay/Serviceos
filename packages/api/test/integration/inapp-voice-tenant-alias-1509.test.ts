/**
 * #1509 — in-app voice resolves a customer by its approved TENANT ALIAS, the
 * same way chat, memo and phone do.
 *
 * The defect: every surface shares one resolver built in app.ts
 * (`AliasFirstEntityResolver → PgEntityResolver`), but the in-app voice
 * adapter was constructed with only `pool`, so it self-built a bare
 * `PgEntityResolver` and never consulted `tenant_entity_aliases`. A customer
 * the owner calls "Bobby Tables" (an approved alias for Roberta Lindqvist)
 * resolved everywhere except in-app voice.
 *
 * Proven through the REAL `createApp()` Express app on real Postgres:
 * `POST /api/voice/sessions` → `POST /api/voice/sessions/:id/input` with an
 * utterance that names the customer ONLY by the alias. No provider key is set,
 * so the app boots its hermetic gateway, which classifies "Draft an estimate
 * for Bobby Tables" as draft_estimate with customerName "Bobby Tables"
 * (ai/providers/mock.ts). The turn must reach the intent readback resolved
 * (pre-fix: "I couldn't find a matching customer for Bobby Tables"), and the
 * proposal the caller's "yes" drafts must carry the aliased customer's id.
 *
 * Run (Docker-gated):
 *   cd packages/api && EXTERNAL_TEST_DB_URL=… npx vitest run \
 *     --config vitest.integration.config.mts test/integration/inapp-voice-tenant-alias-1509.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';
import type { Pool } from 'pg';
import type { AppWithLifecycle } from '../../src/app';
import { getSharedTestDb, closeSharedTestDb, createTestTenant } from './shared';
import { PgEntityAliasRepository } from '../../src/learning/entity-aliases/pg-entity-alias';

const ALIAS = 'Bobby Tables';
const DISPLAY_NAME = 'Roberta Lindqvist';

function unsignedJwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64(claims)}.x`;
}

function bearer(sub: string): string {
  return `Bearer ${unsignedJwt({ sub, sid: `sess-${sub}`, role: 'owner', exp: Math.floor(Date.now() / 1000) + 3600 })}`;
}

describe('#1509 — in-app voice resolves a tenant alias (real createApp, real Postgres)', () => {
  let pool: Pool;
  let app: AppWithLifecycle;
  let prevEnv: Record<string, string | undefined>;
  let userId: string;
  let customerId: string;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    const tenant = await createTestTenant(pool);
    userId = tenant.userId;
    customerId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO customers (id, tenant_id, first_name, last_name, display_name, created_by)
       VALUES ($1, $2, 'Roberta', 'Lindqvist', $3, $4)`,
      [customerId, tenant.tenantId, DISPLAY_NAME, userId],
    );
    // An owner-approved alias, activated the way the adopt_entity_alias
    // handler does it (grounded on an executed clarification).
    const groundedId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO proposals (id, tenant_id, proposal_type, status, payload, summary, created_by)
       VALUES ($1, $2, 'voice_clarification', 'executed', '{}'::jsonb, 'fixture', $3)`,
      [groundedId, tenant.tenantId, userId],
    );
    const approvalId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO proposals (id, tenant_id, proposal_type, status, payload, summary, created_by)
       VALUES ($1, $2, 'adopt_entity_alias', 'approved', $3::jsonb, 'fixture', $4)`,
      [
        approvalId,
        tenant.tenantId,
        JSON.stringify({
          alias: ALIAS,
          entityKind: 'customer',
          entityId: customerId,
          source: 'entity_picker',
          groundedProposalId: groundedId,
        }),
        userId,
      ],
    );
    await new PgEntityAliasRepository(pool).activateFromApprovedProposal({
      tenantId: tenant.tenantId,
      approvalProposalId: approvalId,
      activatedBy: userId,
      actorRole: 'owner',
    });

    prevEnv = {
      NODE_ENV: process.env.NODE_ENV,
      DEV_AUTH_BYPASS: process.env.DEV_AUTH_BYPASS,
      PROCESS_ROLE: process.env.PROCESS_ROLE,
      DATABASE_URL: process.env.DATABASE_URL,
      DB_SSL: process.env.DB_SSL,
      AI_PROVIDER_API_KEY: process.env.AI_PROVIDER_API_KEY,
    };
    process.env.NODE_ENV = 'dev';
    process.env.DEV_AUTH_BYPASS = 'true';
    process.env.PROCESS_ROLE = 'web';
    process.env.DATABASE_URL = process.env.TEST_DB_URL;
    process.env.DB_SSL = 'false';
    delete process.env.AI_PROVIDER_API_KEY;
    const { resetConfig } = await import('../../src/shared/config');
    const { createApp } = await import('../../src/app');
    resetConfig();
    app = createApp();
  });

  afterAll(async () => {
    await app?.gracefulDrain('test-cleanup');
    const { resetConfig } = await import('../../src/shared/config');
    resetConfig();
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await closeSharedTestDb();
  });

  it('a customer named only by its approved alias resolves to that customer', async () => {
    const start = await request(app)
      .post('/api/voice/sessions')
      .set('Authorization', bearer(userId))
      .send({});
    expect(start.status).toBe(201);
    const sessionId = start.body.sessionId as string;

    const turn = await request(app)
      .post(`/api/voice/sessions/${sessionId}/input`)
      .set('Authorization', bearer(userId))
      .send({ text: `Draft an estimate for ${ALIAS}` });

    expect(turn.status).toBe(200);
    // Resolved → the FSM stops at the intent readback. Unresolved, a
    // record-operating intent with zero matches is entity_not_found and the
    // turn falls back to intent_capture ("couldn't find a matching customer").
    expect(turn.body.state).toBe('intent_confirm');
    expect(turn.body.trace.resolution).toBe('resolved');

    // The caller confirms → the drafted proposal carries the ALIASED
    // customer's id (the resolver matched the alias row, not a guess).
    const yes = await request(app)
      .post(`/api/voice/sessions/${sessionId}/input`)
      .set('Authorization', bearer(userId))
      .send({ text: 'Yes' });
    expect(yes.status).toBe(200);
    expect(yes.body.proposalIds).toHaveLength(1);
    const proposal = await request(app)
      .get(`/api/proposals/${yes.body.proposalIds[0]}`)
      .set('Authorization', bearer(userId));
    expect(proposal.status).toBe(200);
    expect(proposal.body.payload.customerId).toBe(customerId);
  });
});
