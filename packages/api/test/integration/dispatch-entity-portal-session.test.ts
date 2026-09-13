/**
 * Docker-gated integration test for migration 269 — the message_dispatches
 * entity_type CHECK must accept 'portal_session' (written by
 * POST /api/portal-sessions/send → SendService.sendPortalLink). A mocked-Pool
 * unit test cannot prove the live constraint; this is exactly the class of
 * gap (in-memory green, Postgres 23514) the migration exists to close.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgDispatchRepository } from '../../src/notifications/dispatch-repository';

describe('migration 269 — message_dispatches accepts portal_session (integration)', () => {
  let pool: Pool;
  let tenantId: string;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    ({ tenantId } = await createTestTenant(pool));
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it("persists a dispatch row with entity_type 'portal_session' through the real repo", async () => {
    const repo = new PgDispatchRepository(pool);
    const dispatch = await repo.create({
      tenantId,
      entityType: 'portal_session',
      entityId: crypto.randomUUID(),
      channel: 'sms',
      recipient: '+15550001111',
      provider: 'in-memory',
      status: 'sent',
    });
    expect(dispatch.id).toBeTruthy();
    expect(dispatch.entityType).toBe('portal_session');
  });

  it('the CHECK constraint is present and still rejects unknown entity types (23514)', async () => {
    await expect(
      pool.query(
        `INSERT INTO message_dispatches
           (tenant_id, entity_type, entity_id, channel, recipient, provider)
         VALUES ($1, 'not_a_real_entity_type', $2, 'sms', '+15550002222', 'in-memory')`,
        [tenantId, crypto.randomUUID()],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
