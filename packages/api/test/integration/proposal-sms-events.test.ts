/**
 * Docker-gated integration tests — NOT run in web sessions. Requires the
 * testcontainer Postgres started by `npm run test:integration`.
 *
 * P2-034 — proposal_sms_events against REAL Postgres (migration 156).
 * The unit suite uses the in-memory repo; these tests pin the actual
 * column names, the CHECK constraints, the open-edit-session predicate
 * (consumed_at IS NULL AND expires_at > now), and RLS tenant isolation —
 * the class of bug that mocked-Pool tests cannot catch.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import {
  getSharedTestDb,
  createTestTenant,
  closeSharedTestDb,
  type TestTenant,
} from './shared';
import {
  PgProposalSmsEventRepository,
  createProposalSmsEvent,
} from '../../src/proposals/sms/sms-event';
import { PgProposalRepository } from '../../src/proposals/pg-proposal';
import { createProposal } from '../../src/proposals/proposal';

describe('Postgres integration — proposal_sms_events (P2-034)', () => {
  let pool: Pool;
  let repo: PgProposalSmsEventRepository;
  let tenant: TestTenant;
  let other: TestTenant;
  let proposalId: string;
  let otherProposalId: string;

  async function seedProposal(tenantId: string): Promise<string> {
    const proposalRepo = new PgProposalRepository(pool);
    const proposal = await proposalRepo.create(
      createProposal({
        tenantId,
        proposalType: 'add_note',
        payload: { message: 'note' },
        summary: 'Add a note',
        createdBy: 'voice',
      }),
    );
    return proposal.id;
  }

  beforeAll(async () => {
    pool = await getSharedTestDb();
    repo = new PgProposalSmsEventRepository(pool);
    tenant = await createTestTenant(pool);
    other = await createTestTenant(pool);
    proposalId = await seedProposal(tenant.tenantId);
    otherProposalId = await seedProposal(other.tenantId);
  }, 120_000);

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('round-trips an outbound render', async () => {
    const event = await repo.create(
      createProposalSmsEvent({
        tenantId: tenant.tenantId,
        proposalId,
        direction: 'outbound',
        kind: 'proposal_rendered',
        body: 'Add a note. Reply Y to approve, N to reject, EDIT to change.',
      }),
    );

    const recent = await repo.findRecentOutbound(tenant.tenantId, 5);
    expect(recent.map((e) => e.id)).toContain(event.id);
    const found = recent.find((e) => e.id === event.id);
    expect(found).toMatchObject({
      tenantId: tenant.tenantId,
      proposalId,
      direction: 'outbound',
      kind: 'proposal_rendered',
    });
    expect(found?.createdAt).toBeInstanceOf(Date);
  });

  it('open edit session honors sender scoping, expiry and consumption', async () => {
    const now = new Date();
    const OWNER = '5125550100';
    const session = await repo.create(
      createProposalSmsEvent({
        tenantId: tenant.tenantId,
        proposalId,
        direction: 'inbound',
        kind: 'edit_session_opened',
        messageSid: 'SM-edit-1',
        fromPhone: OWNER,
        body: 'EDIT',
        expiresAt: new Date(now.getTime() + 10 * 60 * 1000),
      }),
    );

    const open = await repo.findOpenEditSession(tenant.tenantId, OWNER, now);
    expect(open?.id).toBe(session.id);
    expect(open?.fromPhone).toBe(OWNER);

    // Another approver's number never sees this session.
    expect(await repo.findOpenEditSession(tenant.tenantId, '5125550111', now)).toBeNull();

    // After the window the session is gone even unconsumed.
    const afterExpiry = new Date(now.getTime() + 11 * 60 * 1000);
    expect(await repo.findOpenEditSession(tenant.tenantId, OWNER, afterExpiry)).toBeNull();

    // Consumption closes it inside the window too. markConsumed is idempotent.
    await repo.markConsumed(tenant.tenantId, session.id, now);
    await repo.markConsumed(tenant.tenantId, session.id, now);
    expect(await repo.findOpenEditSession(tenant.tenantId, OWNER, now)).toBeNull();
  });

  it('breaks created_at ties by insertion order (seq)', async () => {
    const pA = await seedProposal(tenant.tenantId);
    const pB = await seedProposal(tenant.tenantId);
    // Must be the newest outbound event in this shared tenant for LIMIT 1 to
    // target it. A hardcoded instant is a time bomb: it passed (2026-06-11)
    // and the round-trip test above stamps real now(), which then sorted
    // newer and broke CI. Stay relative to the wall clock instead.
    const sameInstant = new Date(Date.now() + 60 * 60 * 1000);
    for (const proposalIdAtTie of [pA, pB]) {
      await repo.create(
        createProposalSmsEvent({
          tenantId: tenant.tenantId,
          proposalId: proposalIdAtTie,
          direction: 'outbound',
          kind: 'proposal_rendered',
          body: 'render',
          now: sameInstant,
        }),
      );
    }

    const [latest] = await repo.findRecentOutbound(tenant.tenantId, 1);
    expect(latest.proposalId).toBe(pB);
    expect(latest.seq).toBeGreaterThan(0);
  });

  it('tracks unapplied edit requests (blocks SMS approval until re-rendered)', async () => {
    const editProposalId = await seedProposal(tenant.tenantId);
    expect(await repo.hasUnappliedEditRequest(tenant.tenantId, editProposalId)).toBe(false);

    const t0 = new Date('2026-06-11T15:00:00Z');
    await repo.create(
      createProposalSmsEvent({
        tenantId: tenant.tenantId,
        proposalId: editProposalId,
        direction: 'inbound',
        kind: 'edit_request',
        messageSid: 'SM-edit-req-1',
        fromPhone: '5125550100',
        body: 'make it $200',
        now: t0,
      }),
    );
    expect(await repo.hasUnappliedEditRequest(tenant.tenantId, editProposalId)).toBe(true);

    await repo.create(
      createProposalSmsEvent({
        tenantId: tenant.tenantId,
        proposalId: editProposalId,
        direction: 'outbound',
        kind: 'reapproval_rendered',
        body: 'Updated: ...',
        now: new Date(t0.getTime() + 1000),
      }),
    );
    expect(await repo.hasUnappliedEditRequest(tenant.tenantId, editProposalId)).toBe(false);
  });

  it('counts clarification nudges per proposal', async () => {
    expect(await repo.countClarifications(tenant.tenantId, proposalId)).toBe(0);
    await repo.create(
      createProposalSmsEvent({
        tenantId: tenant.tenantId,
        proposalId,
        direction: 'outbound',
        kind: 'clarification_sent',
        body: 'Didn’t catch that. Reply Y, N, or EDIT.',
      }),
    );
    expect(await repo.countClarifications(tenant.tenantId, proposalId)).toBe(1);
  });

  it('is tenant-isolated: tenant B events are invisible to tenant A queries', async () => {
    await repo.create(
      createProposalSmsEvent({
        tenantId: other.tenantId,
        proposalId: otherProposalId,
        direction: 'outbound',
        kind: 'proposal_rendered',
        body: 'Tenant B proposal',
      }),
    );

    const recentA = await repo.findRecentOutbound(tenant.tenantId, 50);
    expect(recentA.every((e) => e.tenantId === tenant.tenantId)).toBe(true);
    expect(recentA.map((e) => e.proposalId)).not.toContain(otherProposalId);
  });

  it('rejects kinds outside the CHECK constraint', async () => {
    await expect(
      repo.create({
        ...createProposalSmsEvent({
          tenantId: tenant.tenantId,
          proposalId,
          direction: 'inbound',
          kind: 'reply_approve',
          body: 'Y',
        }),
        kind: 'bogus_kind' as never,
      }),
    ).rejects.toThrow();
  });
});
