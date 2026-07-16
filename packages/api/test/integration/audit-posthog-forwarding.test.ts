import { describe, it, expect, beforeAll, vi } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant } from './shared';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { ForwardingAuditRepository } from '../../src/audit/forwarding-audit-repository';
import { createAuditEvent } from '../../src/audit/audit';

/**
 * U5 integration — the forwarding decorator over a REAL Postgres audit repo.
 *
 * A mocked-DB unit test proves the decorator's control flow; this proves the
 * seam against real columns: a `proposal.approved` audit row is actually
 * written to `audit_events`, AND the (stubbed) recordProductEvent is invoked
 * with the PERSISTED row's real id/tenant_id — i.e. what PostHog would see in
 * production, using the value that came back from Postgres, not the input.
 */
describe('audit → PostHog forwarding (integration)', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = await getSharedTestDb();
  });

  it('writes a real audit_events row and forwards the persisted event', async () => {
    const { tenantId, userId } = await createTestTenant(pool);
    const record = vi.fn();
    const repo = new ForwardingAuditRepository(new PgAuditRepository(pool), {
      isEnabled: () => true,
      record,
    });

    const saved = await repo.create(
      createAuditEvent({
        tenantId,
        actorId: userId,
        actorRole: 'owner',
        eventType: 'proposal.approved',
        entityType: 'proposal',
        entityId: 'p_integration_1',
        metadata: { proposalType: 'issue_invoice', status: 'approved', channel: 'web' },
      }),
    );

    // 1. A real row was persisted, readable back through the repo.
    const rows = await repo.findByEntity(tenantId, 'proposal', 'p_integration_1');
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(saved.id);
    expect(rows[0].eventType).toBe('proposal.approved');

    // 2. The forward used the PERSISTED event's real id + tenant.
    expect(record).toHaveBeenCalledTimes(1);
    const [name, payload] = record.mock.calls[0];
    expect(name).toBe('proposal_approved');
    expect(payload.tenantId).toBe(tenantId);
    expect(payload.insertId).toBe(saved.id);
    expect(payload.distinctId).toBe(userId);
    expect(payload.properties).toMatchObject({
      feature_domain: 'proposal',
      proposal_type: 'issue_invoice',
      status: 'approved',
      channel: 'web',
    });
  });

  it('persists but does not forward an un-allowlisted event', async () => {
    const { tenantId, userId } = await createTestTenant(pool);
    const record = vi.fn();
    const repo = new ForwardingAuditRepository(new PgAuditRepository(pool), {
      isEnabled: () => true,
      record,
    });

    await repo.create(
      createAuditEvent({
        tenantId,
        actorId: userId,
        actorRole: 'owner',
        eventType: 'note.created',
        entityType: 'note',
        entityId: 'n_integration_1',
      }),
    );

    const rows = await repo.findByEntity(tenantId, 'note', 'n_integration_1');
    expect(rows).toHaveLength(1); // audit still written
    expect(record).not.toHaveBeenCalled(); // but not forwarded
  });
});
