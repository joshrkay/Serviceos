import { describe, it, expect, beforeEach } from 'vitest';
import { OnboardingConversationOrchestrator } from '../../../src/ai/orchestration/onboarding-conversation';
import { InMemoryOnboardingSessionRepository } from '../../../src/db/onboarding-session-repository';
import { InMemoryAuditRepository } from '../../../src/audit/audit';
import { InMemoryProposalRepository, missingFieldsFor, type Proposal } from '../../../src/proposals/proposal';
import { approveProposal, editProposal } from '../../../src/proposals/actions';
import { InMemoryPendingInvitationRepository } from '../../../src/users/pending-invitation';
import { OnboardingTeamMemberExecutionHandler } from '../../../src/proposals/execution/onboarding-handlers';
import type { LLMGateway, LLMRequest, LLMResponse } from '../../../src/ai/gateway/gateway';

const TENANT = 'tenant-team-email-1';
const USER = 'user-team-email-1';
const NOW = new Date('2026-07-29T15:00:00Z');

/**
 * The `email` gate on `onboarding_team_member` was fillable with anything.
 *
 * Voice cannot produce an address from "me and my cousin Carlos", so the
 * proposal is emitted gated on `email` and the operator supplies it from the
 * review card. But `onboardingTeamMemberPayloadSchema` did not DECLARE the key
 * — the per-type schemas are strip-mode, so `editProposal`'s re-validation had
 * nothing to say about it — and `clearSatisfiedMissingFields` lifts a gate for
 * any non-empty string. So `carlos`, or a whitespace-padded address, cleared
 * the gate, the card reported itself satisfied, approval succeeded, and
 * `PendingInvitationRepository.create`'s anchored `EMAIL_RE` refused the
 * address at execution: `execution_failed` after the UI said the gate was
 * satisfied. The same "approvable card that cannot succeed" shape the gate was
 * added to remove, one layer in.
 *
 * The fix declares `email` with `inviteUserSchema`'s rule verbatim
 * (`z.string().trim().email().max(320)`, routes/users.ts) so the review-card
 * path and POST /api/users/invitations cannot drift on what an address is.
 */
function scriptedGateway(scripts: Record<string, unknown>): LLMGateway {
  return {
    async complete(req: LLMRequest): Promise<LLMResponse> {
      const payload = scripts[req.taskType];
      if (payload === undefined) {
        throw new Error(`No script for taskType=${req.taskType}`);
      }
      return {
        content: JSON.stringify(payload),
        model: 'test',
        provider: 'test',
        tokenUsage: { input: 0, output: 0, total: 0 },
        latencyMs: 0,
      };
    },
  } as unknown as LLMGateway;
}

const SCRIPTS = {
  extract_business_profile: {
    business_name: 'Reliable Plumbing',
    city: 'Mesa',
    state: 'AZ',
    verticals: [{ type: 'plumbing', confidence: 0.95, source_text: 'plumbing' }],
    service_descriptions: ['drain cleaning'],
    confidence_score: 0.9,
  },
  extract_categories: {
    categories: [
      { vertical_type: 'plumbing', category_id: 'repair', name: 'Repair', confidence: 0.9, source_text: 'repair' },
    ],
    confidence_score: 0.9,
  },
  extract_pricing: {
    prices: [
      { service_ref: 'labor', amount_cents: 12000, price_type: 'hourly_rate', confidence: 0.9, source_text: '$120 an hour' },
    ],
    confidence_score: 0.9,
  },
  // "me and my cousin Carlos" — a name and an inferred role, no address.
  extract_team: {
    members: [{ name: 'Carlos', inferred_role: 'technician', confidence: 0.95, source_text: 'my cousin Carlos' }],
    confidence_score: 0.9,
  },
  extract_schedule: {
    working_hours: [{ days: ['monday', 'tuesday'], start_time: '08:00', end_time: '17:00' }],
    confidence_score: 0.9,
  },
  extract_tools: {
    tools: [{ name: 'paper', confidence: 0.9, source_text: 'paper' }],
    confidence_score: 0.9,
  },
};

describe('OnboardingConversationOrchestrator — the team-member `email` gate must be fillable only with a real address', () => {
  let sessionRepo: InMemoryOnboardingSessionRepository;
  let auditRepo: InMemoryAuditRepository;
  let proposalRepo: InMemoryProposalRepository;

  beforeEach(() => {
    sessionRepo = new InMemoryOnboardingSessionRepository();
    auditRepo = new InMemoryAuditRepository();
    proposalRepo = new InMemoryProposalRepository();
  });

  async function teamProposal(): Promise<Proposal> {
    const orch = new OnboardingConversationOrchestrator({
      gateway: scriptedGateway(SCRIPTS),
      sessionRepo,
      proposalRepo,
      auditRepo,
      now: () => NOW,
    });
    const opened = await orch.turn({ tenantId: TENANT, userId: USER });
    let last = opened;
    for (let i = 0; i < 14 && !last.completed; i++) {
      last = await orch.turn({
        tenantId: TENANT,
        userId: USER,
        sessionId: opened.sessionId,
        userMessage: last.state === 'review' ? 'looks good' : `Turn ${i}`,
      });
    }
    expect(last.completed).toBe(true);
    const proposals = await Promise.all(
      last.proposalIds.map((id) => proposalRepo.findById(TENANT, id)),
    );
    const team = proposals.find((p) => p?.proposalType === 'onboarding_team_member');
    expect(team).toBeTruthy();
    return team!;
  }

  function handler() {
    return new OnboardingTeamMemberExecutionHandler(
      new InMemoryPendingInvitationRepository(),
      auditRepo,
    );
  }

  it('the spoken capture drafts GATED on email, keeping the name and role', async () => {
    const team = await teamProposal();

    expect(team.payload.name).toBe('Carlos');
    expect(team.payload.role).toBe('technician');
    expect(team.payload.email).toBeUndefined();
    expect(missingFieldsFor(team)).toEqual(['email']);
    await expect(
      approveProposal(proposalRepo, TENANT, team.id, USER, 'owner'),
    ).rejects.toThrow(/unfilled required fields/i);
  });

  it.each([
    ['the bare first name from the review', 'carlos'],
    ['a missing domain', 'carlos@'],
    ['a missing local part', '@example.com'],
    ['an internal space', 'car los@example.com'],
  ])('a malformed email (%s) is REFUSED at edit time and does not clear the gate', async (_label, bad) => {
    const team = await teamProposal();

    // `editProposal` re-validates the merged payload against the type's schema
    // BEFORE `clearSatisfiedMissingFields` runs, so an invalid address never
    // reaches the clear-on-fill step at all.
    await expect(
      editProposal(proposalRepo, TENANT, team.id, USER, 'owner', { email: bad }),
    ).rejects.toThrow(/Invalid payload after edit/i);

    const refetched = await proposalRepo.findById(TENANT, team.id);
    // The gate is still up, the bad value was not persisted, and approval is
    // still refused — i.e. the operator is asked again rather than handed an
    // execution_failed after the UI called the card satisfied.
    expect(missingFieldsFor(refetched!)).toEqual(['email']);
    expect(refetched!.payload.email).toBeUndefined();
    await expect(
      approveProposal(proposalRepo, TENANT, team.id, USER, 'owner'),
    ).rejects.toThrow(/unfilled required fields/i);
  });

  it('the counterfactual: the address the schema refuses is exactly the one execution would have died on', async () => {
    // Proof that the edit-time refusal is not merely stricter-for-its-own-sake:
    // hand the handler the value that used to clear the gate and watch the
    // invitation repository reject it — the `execution_failed` the operator
    // used to get AFTER approving.
    const team = await teamProposal();
    const result = await handler().execute(
      { ...team, payload: { ...team.payload, email: 'carlos' } },
      { tenantId: TENANT, executedBy: USER, executedByRole: 'owner' },
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/valid email/i);
  });

  it('the gate is fillable end to end: edit → gate clears → approve → execute → a real invitation', async () => {
    const team = await teamProposal();

    const { proposal: edited } = await editProposal(
      proposalRepo,
      TENANT,
      team.id,
      USER,
      'owner',
      { email: 'carlos@example.com' },
    );
    expect(missingFieldsFor(edited)).toEqual([]);

    const approved = await approveProposal(proposalRepo, TENANT, team.id, USER, 'owner');
    expect(approved.status).toBe('approved');

    const invitationRepo = new InMemoryPendingInvitationRepository();
    const result = await new OnboardingTeamMemberExecutionHandler(
      invitationRepo,
      auditRepo,
    ).execute(approved, { tenantId: TENANT, executedBy: USER, executedByRole: 'owner' });

    expect(result.success).toBe(true);
    const invitations = await invitationRepo.findByTenant(TENANT);
    expect(invitations).toHaveLength(1);
    expect(invitations[0].email).toBe('carlos@example.com');
    expect(invitations[0].role).toBe('technician');
  });

  it('a whitespace-padded address clears the gate AND then executes (the schema trims, so the handler must too)', async () => {
    // `validateProposalPayload` only safeParses — it keeps the operator's raw
    // string on the payload — so the schema's `.trim()` accepting this value
    // is not on its own enough: without the handler trimming as well, the
    // padded address reaches the invitation repository's anchored EMAIL_RE and
    // fails at execution. Gate and handler have to agree.
    const team = await teamProposal();

    const { proposal: edited } = await editProposal(
      proposalRepo,
      TENANT,
      team.id,
      USER,
      'owner',
      { email: '  carlos@example.com  ' },
    );
    expect(missingFieldsFor(edited)).toEqual([]);

    const approved = await approveProposal(proposalRepo, TENANT, team.id, USER, 'owner');
    const invitationRepo = new InMemoryPendingInvitationRepository();
    const result = await new OnboardingTeamMemberExecutionHandler(
      invitationRepo,
      auditRepo,
    ).execute(approved, { tenantId: TENANT, executedBy: USER, executedByRole: 'owner' });

    expect(result.success).toBe(true);
    const invitations = await invitationRepo.findByTenant(TENANT);
    expect(invitations[0].email).toBe('carlos@example.com');
  });
});
