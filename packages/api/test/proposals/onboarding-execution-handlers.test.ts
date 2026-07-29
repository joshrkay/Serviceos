import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OnboardingTeamMemberExecutionHandler } from '../../src/proposals/execution/onboarding-handlers';
import type { ExecutionContext } from '../../src/proposals/execution/handlers';
import type { Proposal, ProposalType } from '../../src/proposals/proposal';

const TENANT = '11111111-1111-1111-1111-111111111111';

const context: ExecutionContext = {
  tenantId: TENANT,
  executedBy: 'user_owner',
  executedByRole: 'owner',
};

function proposalOf(proposalType: ProposalType, payload: Record<string, unknown>): Proposal {
  return {
    id: 'prop_1',
    tenantId: TENANT,
    proposalType,
    status: 'approved',
    payload,
    summary: 'test proposal',
  } as Proposal;
}

describe('OnboardingTeamMemberExecutionHandler', () => {
  const invitation = {
    id: 'inv_1',
    tenantId: TENANT,
    email: 'carlos@example.com',
    role: 'technician' as const,
    invitedBy: 'user_owner',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    expiresAt: new Date('2026-01-15T00:00:00Z'),
  };
  let invitationRepo: { create: ReturnType<typeof vi.fn> };
  let auditRepo: { create: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    invitationRepo = { create: vi.fn().mockResolvedValue(invitation) };
    auditRepo = { create: vi.fn().mockResolvedValue(undefined) };
  });

  const payload = { name: 'Carlos', role: 'technician', email: 'carlos@example.com' };

  it('sends the Clerk invitation, not just a local row', async () => {
    const clerkFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'clerk_inv_9' }),
    });
    const handler = new OnboardingTeamMemberExecutionHandler(
      invitationRepo as never,
      auditRepo as never,
      { clerkSecretKey: 'sk_test', clerkFetch: clerkFetch as never, appBaseUrl: 'https://app.test' },
    );

    const result = await handler.execute(proposalOf('onboarding_team_member', payload), context);

    expect(result.success).toBe(true);
    expect(result.resultEntityId).toBe('inv_1');
    expect(clerkFetch).toHaveBeenCalledTimes(1);
    const [url, init] = clerkFetch.mock.calls[0];
    expect(url).toBe('https://api.clerk.com/v1/invitations');
    const body = JSON.parse((init as { body: string }).body);
    expect(body.email_address).toBe('carlos@example.com');
    // The webhook joins the accepted sign-up back to the local row by this id.
    expect(body.public_metadata).toMatchObject({
      invitation_id: 'inv_1',
      tenant_id: TENANT,
      role: 'technician',
    });
    expect(body.redirect_url).toContain('https://app.test/accept-invitation');
    expect(auditRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'user.invitation_created',
        metadata: expect.objectContaining({ clerkInvitationId: 'clerk_inv_9' }),
      }),
    );
  });

  it('keeps the local row and reports an unsent invitation when Clerk fails', async () => {
    const clerkFetch = vi.fn().mockRejectedValue(new Error('clerk unreachable'));
    const handler = new OnboardingTeamMemberExecutionHandler(
      invitationRepo as never,
      auditRepo as never,
      { clerkSecretKey: 'sk_test', clerkFetch: clerkFetch as never },
    );

    const result = await handler.execute(proposalOf('onboarding_team_member', payload), context);

    expect(result.success).toBe(true);
    expect(invitationRepo.create).toHaveBeenCalledTimes(1);
    expect(auditRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ clerkInvitationId: null }),
      }),
    );
  });

  it('refuses without an email rather than inventing an address', async () => {
    const handler = new OnboardingTeamMemberExecutionHandler(
      invitationRepo as never,
      auditRepo as never,
    );

    const result = await handler.execute(
      proposalOf('onboarding_team_member', { name: 'Carlos', role: 'technician' }),
      context,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('email');
    expect(invitationRepo.create).not.toHaveBeenCalled();
  });
});
