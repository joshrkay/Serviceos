/**
 * Postgres integration — `call_me_back_tasks` idempotency key (migration 198).
 *
 * The key was `(tenant_id, session_id)`, which collapsed DISTINCT follow-ups
 * for one call into a single row. On an E1 life-safety call the FSM emits
 * `revoke_pending_bookings` BEFORE `notify_tenant_emergency`, so a tenant that
 * both left a live booking AND had no reachable number got the booking task
 * inserted first and the life-safety ALERT task silently swallowed by the
 * conflict — the one durable fallback the alert depends on.
 *
 * `reason` now joins the key. This pins the real partial unique index and the
 * ON CONFLICT target against real Postgres: distinct reasons coexist, the same
 * reason still dedups.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant } from './shared';
import { PgCallMeBackRepository } from '../../src/voice/call-me-back/pg-call-me-back';

describe('Postgres integration — call_me_back (tenant, session, reason) idempotency', () => {
  let pool: Pool;
  let repo: PgCallMeBackRepository;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    repo = new PgCallMeBackRepository(pool);
  });

  it('keeps BOTH E1 tasks for one session when the reasons differ', async () => {
    const tenant = await createTestTenant(pool);
    const sessionId = `sess-${crypto.randomUUID()}`;

    // Same order the E1 FSM emits them in.
    const bookingTask = await repo.create({
      tenantId: tenant.tenantId,
      sessionId,
      callerPhone: '+15125550100',
      callbackMessage: 'EMERGENCY (E1): a booking could NOT be revoked.',
      reason: 'life_safety_e1_booking_live',
    });
    const alertTask = await repo.create({
      tenantId: tenant.tenantId,
      sessionId,
      callerPhone: '+15125550100',
      callbackMessage: '⚠️ EMERGENCY (E1 life-safety) call just came in.',
      reason: 'life_safety_e1',
    });

    expect(alertTask.id).not.toBe(bookingTask.id);
    expect(alertTask.reason).toBe('life_safety_e1');
    // Both are really persisted and both reach the CSR sweep.
    const pending = await repo.listPending(tenant.tenantId);
    const reasons = pending.filter((t) => t.sessionId === sessionId).map((t) => t.reason);
    expect(reasons).toContain('life_safety_e1_booking_live');
    expect(reasons).toContain('life_safety_e1');
  });

  it('still dedups a retry of the SAME (session, reason)', async () => {
    const tenant = await createTestTenant(pool);
    const sessionId = `sess-${crypto.randomUUID()}`;

    const first = await repo.create({
      tenantId: tenant.tenantId,
      sessionId,
      callerPhone: '+15125550100',
      callbackMessage: 'Please call me back',
      reason: 'transfer_failed',
    });
    // A Twilio retry of /callback-message must not notify the CSR twice.
    const retry = await repo.create({
      tenantId: tenant.tenantId,
      sessionId,
      callerPhone: '+15125550100',
      callbackMessage: 'Please call me back',
      reason: 'transfer_failed',
    });

    expect(retry.id).toBe(first.id);
    const rows = await pool.query(
      `SELECT COUNT(*)::int AS n FROM call_me_back_tasks
        WHERE tenant_id = $1 AND session_id = $2 AND reason = 'transfer_failed'`,
      [tenant.tenantId, sessionId],
    );
    expect(rows.rows[0].n).toBe(1);
  });

  it('the superseded (tenant_id, session_id) index is gone', async () => {
    // Migration 198 drops it; if it survived, the reason-keyed insert above
    // would still conflict in a fresh database.
    const r = await pool.query(
      `SELECT indexname FROM pg_indexes
        WHERE tablename = 'call_me_back_tasks'
          AND indexname IN ('idx_cmb_session_unique', 'idx_cmb_session_reason_unique')`,
    );
    const names = r.rows.map((row: { indexname: string }) => row.indexname);
    expect(names).toContain('idx_cmb_session_reason_unique');
    expect(names).not.toContain('idx_cmb_session_unique');
  });
});
