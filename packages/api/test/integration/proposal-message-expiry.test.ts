import { describe, it, expect, beforeAll } from 'vitest';
import crypto from 'crypto';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant } from './shared';
import { PgProposalRepository } from '../../src/proposals/pg-proposal';
import {
  createProposal,
  MESSAGE_PROPOSAL_TYPES,
  SCHEDULE_PROPOSAL_TYPES,
  EXPIRING_PROPOSAL_TYPES,
  PROPOSAL_EXPIRY_MS,
} from '../../src/proposals/proposal';

/**
 * §10.4 — message (outbound comms) proposals carry a 48h TTL, pinned against a
 * real Postgres. Mocked-DB tests can't prove the `expires_at` column is written
 * for message proposals or that the renamed `findExpiredProposalsByType` query
 * filters by the message-type set — this exercises both on the real schema
 * (migration 027 `proposals.expires_at`).
 *
 * Contract pinned here:
 *   - A freshly created message proposal persists `expires_at ≈ now + 48h`.
 *   - A persisting (non-expiring) type persists a NULL `expires_at`.
 *   - findExpiredProposalsByType returns expired message rows when the message
 *     type set is passed, and excludes them when only schedule types are passed.
 */
describe('PgProposalRepository — §10.4 message proposal expiry', () => {
  let pool: Pool;
  let repo: PgProposalRepository;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    repo = new PgProposalRepository(pool);
  });

  it('persists expires_at ≈ now+48h for a message proposal', async () => {
    const tenant = await createTestTenant(pool);
    const p = createProposal({
      tenantId: tenant.tenantId,
      proposalType: 'send_invoice',
      payload: {},
      summary: 'send invoice',
      createdBy: tenant.userId,
      idempotencyKey: crypto.randomUUID(),
    });
    await repo.create(p);

    const got = await repo.findById(tenant.tenantId, p.id);
    expect(got?.expiresAt).toBeInstanceOf(Date);
    const delta = got!.expiresAt!.getTime() - p.createdAt.getTime();
    // Round-trips through TIMESTAMPTZ; allow a small tolerance for ms precision.
    expect(Math.abs(delta - PROPOSAL_EXPIRY_MS)).toBeLessThan(1000);
  });

  it('persists a NULL expires_at for a non-expiring (persisting) type', async () => {
    const tenant = await createTestTenant(pool);
    const p = createProposal({
      tenantId: tenant.tenantId,
      proposalType: 'create_customer',
      payload: {},
      summary: 'add customer',
      createdBy: tenant.userId,
      idempotencyKey: crypto.randomUUID(),
    });
    await repo.create(p);

    const got = await repo.findById(tenant.tenantId, p.id);
    expect(got?.expiresAt).toBeUndefined();
  });

  it('findExpiredProposalsByType returns expired message rows, filtered by the type set', async () => {
    const tenant = await createTestTenant(pool);
    const past = new Date(Date.now() - 60 * 60 * 1000); // 1h ago
    const message = createProposal({
      tenantId: tenant.tenantId,
      proposalType: 'notify_delay',
      payload: {},
      summary: 'running late',
      createdBy: tenant.userId,
      idempotencyKey: crypto.randomUUID(),
      expiresAt: past,
    });
    await repo.create(message);
    await repo.updateStatus(tenant.tenantId, message.id, 'expired');

    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    // Message types (and the combined expiring set) surface it…
    const byMessage = await repo.findExpiredProposalsByType(
      tenant.tenantId,
      MESSAGE_PROPOSAL_TYPES,
      since,
      10,
    );
    expect(byMessage.map((r) => r.id)).toContain(message.id);

    const byExpiring = await repo.findExpiredProposalsByType(
      tenant.tenantId,
      EXPIRING_PROPOSAL_TYPES,
      since,
      10,
    );
    expect(byExpiring.map((r) => r.id)).toContain(message.id);

    // …but the schedule-only set must exclude it (pins the real type filter).
    const bySchedule = await repo.findExpiredProposalsByType(
      tenant.tenantId,
      SCHEDULE_PROPOSAL_TYPES,
      since,
      10,
    );
    expect(bySchedule.map((r) => r.id)).not.toContain(message.id);
  });
});
