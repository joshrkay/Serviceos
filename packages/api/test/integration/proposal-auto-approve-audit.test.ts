/**
 * D-014 (Governed Autonomy) — pins the real audit row for an auto-approval.
 *
 * The unit test (test/proposals/auto-approve-audit.test.ts) proves the
 * createProposal wiring + the factory's event shape against an in-memory
 * audit repo. This integration test pins the live `audit_events` columns:
 * actor_id / actor_role and the jsonb `metadata` provenance round-trip
 * through Postgres (per CLAUDE.md: a mocked-DB test is not sufficient proof).
 */
import { describe, it, expect, afterAll } from 'vitest';
import { getSharedTestDb, closeSharedTestDb, createTestTenant } from './shared';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { createProposal } from '../../src/proposals/proposal';
import {
  createProposalApprovalAuditor,
  AUTO_APPROVE_ACTOR_ID,
} from '../../src/proposals/approval-audit-hook';

describe('D-014 — auto-approval audit (pg)', () => {
  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('persists a policy-attributed proposal.approved row with provenance', async () => {
    const pool = await getSharedTestDb();
    const { tenantId, userId } = await createTestTenant(pool);
    const auditRepo = new PgAuditRepository(pool);
    const auditor = createProposalApprovalAuditor(auditRepo);

    const proposal = createProposal({
      tenantId,
      proposalType: 'add_note', // capture-class, non-schedule
      payload: { body: 'note', _meta: { overallConfidence: 'high' } },
      summary: 'Add a note',
      createdBy: userId,
      sourceTrustTier: 'autonomous',
      confidenceScore: 0.95,
      supervisorMode: 'supervisor',
    });
    expect(proposal.status).toBe('approved');

    await auditor.recordAutoApproval(proposal, {
      supervisorMode: 'supervisor',
      threshold: 0.9,
      sourceTrustTier: 'autonomous',
    });

    const events = await auditRepo.findByEntity(tenantId, 'proposal', proposal.id);
    expect(events).toHaveLength(1);
    const ev = events[0];
    expect(ev.eventType).toBe('proposal.approved');
    expect(ev.actorId).toBe(AUTO_APPROVE_ACTOR_ID);
    expect(ev.actorRole).toBe('system');
    // jsonb provenance survives the Postgres round-trip with types intact.
    expect(ev.metadata).toMatchObject({
      auto: true,
      supervisorMode: 'supervisor',
      autoApproveThreshold: 0.9,
      confidenceScore: 0.95,
      overallConfidence: 'high',
      sourceTrustTier: 'autonomous',
      undoWindowMs: 5000,
      proposalType: 'add_note',
      status: 'approved',
    });
  });
});
