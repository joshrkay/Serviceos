import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  createProposal,
  type CreateProposalInput,
} from '../../src/proposals/proposal';
import {
  configureProposalApprovalAuditor,
  createProposalApprovalAuditor,
  AUTO_APPROVE_ACTOR_ID,
} from '../../src/proposals/approval-audit-hook';
import { InMemoryAuditRepository } from '../../src/audit/audit';

// D-014 (Governed Autonomy): every auto-approval at decide time must emit an
// explicit policy-actor approval audit. These tests pin (1) the createProposal
// wiring — fires only for status==='approved' — and (2) the production
// factory's event shape (actor + provenance metadata).

const baseInput = (
  overrides: Partial<CreateProposalInput> = {},
): CreateProposalInput => ({
  tenantId: 'tenant-1',
  proposalType: 'add_note', // capture-class, non-schedule (no expiry side effects)
  payload: { body: 'hello' },
  summary: 'Add a note',
  createdBy: 'user-1',
  ...overrides,
});

afterEach(() => {
  configureProposalApprovalAuditor(null);
  vi.restoreAllMocks();
});

describe('D-014 — auto-approval audit attribution', () => {
  it('fires the auditor exactly once when a proposal auto-approves at birth', () => {
    const recordAutoApproval = vi.fn(async () => {});
    configureProposalApprovalAuditor({ recordAutoApproval });

    const proposal = createProposal(
      baseInput({ sourceTrustTier: 'autonomous', confidenceScore: 0.95 }),
    );

    expect(proposal.status).toBe('approved');
    expect(recordAutoApproval).toHaveBeenCalledTimes(1);
    const [auditedProposal, provenance] = recordAutoApproval.mock.calls[0];
    expect(auditedProposal.id).toBe(proposal.id);
    expect(auditedProposal.status).toBe('approved');
    expect(provenance.threshold).toBe(0.9); // legacy default (no supervisorMode)
    expect(provenance.sourceTrustTier).toBe('autonomous');
  });

  it('does NOT fire the auditor when the proposal does not auto-approve', () => {
    const recordAutoApproval = vi.fn(async () => {});
    configureProposalApprovalAuditor({ recordAutoApproval });

    // No sourceTrustTier → draft.
    const draft = createProposal(baseInput({ confidenceScore: 0.99 }));
    expect(draft.status).toBe('draft');

    // Unsupervised hard-block → ready_for_review, never approved.
    const unsupervised = createProposal(
      baseInput({
        sourceTrustTier: 'autonomous',
        confidenceScore: 0.99,
        supervisorPresent: false,
      }),
    );
    expect(unsupervised.status).toBe('ready_for_review');

    expect(recordAutoApproval).not.toHaveBeenCalled();
  });

  it('is unchanged (no throw, still approves) when no auditor is configured', () => {
    configureProposalApprovalAuditor(null);
    const proposal = createProposal(
      baseInput({ sourceTrustTier: 'autonomous', confidenceScore: 0.95 }),
    );
    expect(proposal.status).toBe('approved');
  });

  it('factory emits a policy-attributed proposal.approved audit event', async () => {
    const auditRepo = new InMemoryAuditRepository();
    const auditor = createProposalApprovalAuditor(auditRepo);

    const proposal = createProposal(
      baseInput({
        sourceTrustTier: 'autonomous',
        confidenceScore: 0.95,
        supervisorMode: 'supervisor',
        payload: { body: 'hello', _meta: { overallConfidence: 'high' } },
      }),
    );
    await auditor.recordAutoApproval(proposal, {
      supervisorMode: 'supervisor',
      threshold: 0.9,
      sourceTrustTier: 'autonomous',
    });

    const events = await auditRepo.findByEntity(
      'tenant-1',
      'proposal',
      proposal.id,
    );
    expect(events).toHaveLength(1);
    const ev = events[0];
    expect(ev.eventType).toBe('proposal.approved');
    expect(ev.actorId).toBe(AUTO_APPROVE_ACTOR_ID);
    expect(ev.actorRole).toBe('system');
    expect(ev.metadata).toMatchObject({
      auto: true,
      supervisorMode: 'supervisor',
      autoApproveThreshold: 0.9,
      confidenceScore: 0.95,
      overallConfidence: 'high',
      sourceTrustTier: 'autonomous',
      undoWindowMs: 5000,
    });
  });
});
