/**
 * B3-5 — a voice "yes" on a card the reference checks hold says what is wrong.
 *
 * The voice approval runs the same approval-time reference checks as the
 * dashboard (B4). When they hold a card — here its job belongs to another
 * customer — nothing on it is missing, yet the line said "Can't approve that
 * yet — it's missing required info." The SMS reply was corrected in B4's
 * follow-up; the voice line now says the same thing in speech form. A card
 * that really has an unfilled field keeps the missing-info line.
 */
import { describe, it, expect } from 'vitest';
import {
  startVoiceApproval,
  continueVoiceApproval,
  type VoiceApprovalDeps,
  type VoiceApprovalSessionRef,
} from '../../../src/ai/tasks/proposal-approval-task';
import { createProposal, InMemoryProposalRepository, type Proposal } from '../../../src/proposals/proposal';
import { InMemoryAuditRepository } from '../../../src/audit/audit';
import { InMemoryProposalSmsEventRepository } from '../../../src/proposals/sms/sms-event';
import { jobReferenceCheck } from '../../../src/proposals/approval-reference-checks';
import { InMemoryJobRepository, createJob } from '../../../src/jobs/job';
import type { SettingsRepository } from '../../../src/settings/settings';

const TENANT = 't-voice-held';
const CUSTOMER = '7a1b2c3d-1111-4111-8111-111111111111';
const OTHER_CUSTOMER = '7a1b2c3d-2222-4222-8222-222222222222';
const OWNER_LINE: VoiceApprovalSessionRef = { tenantId: TENANT, sessionId: 'sess-held', ownerSession: true };
const BANNED = /\b(AI|agent|dashboard|verify|provisioning|proposal|Stripe|Twilio)\b/i;

async function harness() {
  const proposalRepo = new InMemoryProposalRepository();
  const auditRepo = new InMemoryAuditRepository();
  const jobRepo = new InMemoryJobRepository();
  const deps: VoiceApprovalDeps = {
    proposalRepo,
    auditRepo,
    settingsRepo: {
      findByTenant: async () => ({ ownerPhone: '+15125550100', escalationSettings: {} }),
    } as unknown as SettingsRepository,
    smsEventRepo: new InMemoryProposalSmsEventRepository(),
    approvalReferenceChecks: [jobReferenceCheck(jobRepo)],
  };
  const jobOf = async (customerId: string) =>
    (await createJob({ tenantId: TENANT, customerId, locationId: 'loc-1', summary: 'Furnace', createdBy: 'seed' }, jobRepo)).id;
  return { deps, proposalRepo, auditRepo, jobOf };
}

async function seed(repo: InMemoryProposalRepository, input: Parameters<typeof createProposal>[0]): Promise<Proposal> {
  const proposal = await repo.create({ ...createProposal(input), status: 'ready_for_review' });
  return proposal;
}

async function approveByVoice(deps: VoiceApprovalDeps) {
  const readback = await startVoiceApproval(deps, { ...OWNER_LINE, action: 'approve', reference: 'approve it' });
  expect(readback.outcome).toBe('readback');
  return continueVoiceApproval(deps, { ...OWNER_LINE, utterance: 'yes', pending: readback.pending! });
}

describe('B3-5 — the voice line says why a card cannot be approved yet', () => {
  it("a card whose job is another customer's: something needs fixing, nothing is missing", async () => {
    const h = await harness();
    const proposal = await seed(h.proposalRepo, {
      tenantId: TENANT,
      proposalType: 'create_appointment',
      payload: {
        customerId: CUSTOMER,
        jobId: await h.jobOf(OTHER_CUSTOMER),
        customerName: 'Mrs Lee',
        scheduledStart: '2026-06-16T19:00:00Z',
        scheduledEnd: '2026-06-16T20:00:00Z',
      },
      summary: 'Book Mrs Lee Tuesday 2pm',
      confidenceScore: 0.97,
      createdBy: 'voice',
    });

    const result = await approveByVoice(h.deps);

    expect(result.outcome).toBe('approve_failed');
    expect(result.speak).toBe("Can't approve that yet — something on it needs fixing first. Fix it in the app.");
    expect(result.speak).not.toMatch(/missing/i);
    expect(result.speak).not.toMatch(BANNED);
    expect((await h.proposalRepo.findById(TENANT, proposal.id))?.status).toBe('ready_for_review');
    expect(h.auditRepo.getAll().find((e) => e.eventType === 'proposal.voice_approve_blocked')?.metadata).toMatchObject({
      heldBy: 'reference_check',
    });
  });

  it('a card with an unfilled field keeps the missing-info line', async () => {
    const h = await harness();
    await seed(h.proposalRepo, {
      tenantId: TENANT,
      proposalType: 'create_appointment',
      payload: { customerName: 'Mrs Lee' },
      summary: 'Book Mrs Lee',
      createdBy: 'voice',
      sourceContext: { missingFields: ['scheduledStart'] },
    });

    const result = await approveByVoice(h.deps);

    expect(result.outcome).toBe('approve_failed');
    expect(result.speak).toBe("Can't approve that yet — it's missing required info. Finish it in your review queue.");
    expect(h.auditRepo.getAll().find((e) => e.eventType === 'proposal.voice_approve_blocked')?.metadata).not.toHaveProperty(
      'heldBy',
    );
  });
});

// B3-6 follow-up — the voice twin of the SMS expiry reply. A schedule card's
// 48-hour window is swept hourly, so between its expiresAt and the sweep a
// spoken yes still reaches approveProposal, which marks the card expired and
// refuses with a ValidationError that names no fields. The line said "it's
// missing required info" — nothing was missing, and it cannot be finished.
describe('B3-6 — a voice yes on a card whose window has just passed', () => {
  it('says it expired, approves nothing, and does not claim missing info', async () => {
    const h = await harness();
    const proposal = await seed(h.proposalRepo, {
      tenantId: TENANT,
      proposalType: 'create_appointment',
      payload: {
        customerName: 'Mrs Lee',
        scheduledStart: '2026-06-16T19:00:00Z',
        scheduledEnd: '2026-06-16T20:00:00Z',
      },
      summary: 'Book Mrs Lee Tuesday 2pm',
      confidenceScore: 0.97,
      createdBy: 'voice',
      expiresAt: new Date(Date.now() - 60_000),
    });

    const result = await approveByVoice(h.deps);

    expect(result.outcome).toBe('approve_failed');
    expect(result.speak).toBe("Can't approve that one — it expired. You can redo it in the app.");
    expect(result.speak).not.toMatch(/missing/i);
    expect(result.speak).not.toMatch(BANNED);
    expect((await h.proposalRepo.findById(TENANT, proposal.id))?.status).toBe('expired');
    expect(h.auditRepo.getAll().map((e) => e.eventType)).not.toContain('proposal.approved');
    expect(h.auditRepo.getAll().find((e) => e.eventType === 'proposal.voice_approve_blocked')?.metadata).toMatchObject({
      heldBy: 'expired',
    });
  });
});
