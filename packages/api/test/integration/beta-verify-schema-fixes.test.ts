/**
 * Postgres integration — regression guards for three schema bugs found in the
 * 2026-06-25 beta verification run. Each is the exact "mocked-Pool hid a real
 * schema mismatch" failure mode CLAUDE.md warns about: the existing unit/route
 * tests mocked pg and stayed green while the real column/table was wrong.
 *
 *   1. proposals.claimed_by was UUID, but the execution worker passes the
 *      string label 'execution-worker'. Every claimForExecution threw
 *      `invalid input syntax for type uuid`, so NO approved proposal ever
 *      reached 'executing'/'executed' — proposal execution was silently
 *      broken in production. (migration 215: claimed_by -> TEXT)
 *   2. delay_notice_state never existed, but PgDelayNoticeStateRepository is
 *      wired in production. upsert() threw, the route swallowed it, and the
 *      running-late SMS was silently dropped. (migration 216)
 *   3. The interactions route joined `locations`.`address_line1` — neither
 *      exists (table is service_locations, column is street1) — so
 *      GET /api/interactions 500'd for every tenant.
 */
import express from 'express';
import request from 'supertest';
import crypto from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { closeSharedTestDb, createTestTenant, getSharedTestDb } from './shared';
import { PgProposalRepository } from '../../src/proposals/pg-proposal';
import { PgDelayNoticeStateRepository } from '../../src/notifications/pg-delay-notice-state';
import { createInteractionsRouter } from '../../src/routes/interactions';

let pool: Pool;
beforeAll(async () => {
  pool = await getSharedTestDb();
});
afterAll(async () => {
  await closeSharedTestDb();
});

describe('beta-verify schema fixes (real Postgres)', () => {
  it('claimForExecution accepts the string worker label — proposals.claimed_by is TEXT (migration 215)', async () => {
    const { tenantId, userId } = await createTestTenant(pool);
    const proposalId = crypto.randomUUID();
    // An approved proposal, past the undo window — exactly what the worker sweep sees.
    await pool.query(
      `INSERT INTO proposals (id, tenant_id, proposal_type, created_by, status, approved_at)
       VALUES ($1, $2, 'reschedule_appointment', $3, 'approved', NOW() - INTERVAL '1 minute')`,
      [proposalId, tenantId, userId]
    );

    const repo = new PgProposalRepository(pool);

    // findReadyForExecution must return the approved-past-window row...
    const ready = await repo.findReadyForExecution(5000);
    expect(ready.some((p) => p.id === proposalId)).toBe(true);

    // ...and claiming it with the PRODUCTION default worker id (the STRING
    // 'execution-worker', not a uuid) must succeed. Pre-migration-215 this
    // threw `invalid input syntax for type uuid: "execution-worker"`.
    const claimed = await repo.claimForExecution(proposalId, 'execution-worker');
    expect(claimed).not.toBeNull();
    expect(claimed!.status).toBe('executing');
    expect(claimed!.claimedBy).toBe('execution-worker');
  });

  it('PgDelayNoticeStateRepository.upsert round-trips — delay_notice_state exists (migration 216)', async () => {
    const { tenantId } = await createTestTenant(pool);
    const repo = new PgDelayNoticeStateRepository(pool);
    const key = `delay-${crypto.randomUUID()}`;
    const base = {
      idempotencyKey: key,
      tenantId,
      appointmentId: crypto.randomUUID(),
      delayVersion: 1,
      status: 'queued' as const,
      channel: 'sms' as const,
      attempts: 0,
      maxAttempts: 3,
      updatedAt: new Date(),
    };

    const saved = await repo.upsert(base);
    expect(saved.idempotencyKey).toBe(key);

    const found = await repo.findByKey(key);
    expect(found).not.toBeNull();
    expect(found!.status).toBe('queued');

    // Same key upserts in place — this is the idempotency guard that was dead
    // while the table was missing.
    await repo.upsert({ ...base, status: 'sent', attempts: 1, updatedAt: new Date() });
    const after = await repo.findByKey(key);
    expect(after!.status).toBe('sent');
    expect(after!.attempts).toBe(1);
  });

  it('GET /api/interactions resolves service_locations.street1 — returns 200, not 500', async () => {
    const { tenantId, userId } = await createTestTenant(pool);
    const customerId = crypto.randomUUID();
    const locationId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();

    await pool.query(
      `INSERT INTO customers (id, tenant_id, first_name, last_name, display_name, created_by)
       VALUES ($1, $2, 'Ada', 'Lovelace', 'Ada Lovelace', $3)`,
      [customerId, tenantId, userId]
    );
    await pool.query(
      `INSERT INTO service_locations (id, tenant_id, customer_id, street1, city, state, postal_code)
       VALUES ($1, $2, $3, '1 Analytical Way', 'Austin', 'TX', '78701')`,
      [locationId, tenantId, customerId]
    );
    await pool.query(
      `INSERT INTO voice_sessions (id, tenant_id, channel, state, customer_id, started_at)
       VALUES ($1, $2, 'voice_inbound', 'completed', $3, NOW())`,
      [sessionId, tenantId, customerId]
    );

    // Drive the REAL route (not a copied query). A stub auth middleware injects
    // req.auth so requireAuth/requireTenant pass; the route's own SQL is exercised.
    const app = express();
    app.use((req, _res, next) => {
      (req as express.Request & { auth: unknown }).auth = {
        tenantId,
        userId,
        sessionId: 'sess-test',
        role: 'owner',
      };
      next();
    });
    app.use('/api/interactions', createInteractionsRouter({ pool }));

    const res = await request(app).get('/api/interactions?limit=10');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].customer.address).toBe('1 Analytical Way');
  });
});
