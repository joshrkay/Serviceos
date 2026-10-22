/**
 * B1 follow-up — the Layer 1 text-mode driver approves as WHO is calling.
 *
 * Production (TwilioGatherAdapter.establishInboundSession) resolves the owner
 * line's approver from the caller-ID — the owner phone is the owner, the
 * backup supervisor's mobile is the backup's own role and user — and carries
 * it on the session for every approval turn. The driver kept the boolean
 * owner-line check and carried no approver, so a corpus call from the backup's
 * mobile approved as 'owner': a dispatcher backup stamped executedByRole
 * 'owner', and a technician backup — who holds no proposals:approve — approved
 * at all.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import { AgentEventBus } from '../../src/ai/voice-quality/event-bus';
import { TextModeDriver } from '../../src/ai/voice-quality/text-mode-driver';
import { createMockLLMGateway } from '../../src/ai/gateway/factory';
import { InMemoryProposalRepository, createProposal, type Proposal } from '../../src/proposals/proposal';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemoryCustomerRepository } from '../../src/customers/customer';
import { InMemoryUserRepository } from '../../src/users/user';
import type { SettingsRepository } from '../../src/settings/settings';

const TENANT = 't-vq-backup-approver';
const OWNER_PHONE = '+15125550100';
const BACKUP_MOBILE = '+15125550111';
const BACKUP_ID = 'user-vq-backup';
const BACKUP_SUBJECT = 'clerk-vq-backup';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

async function build(role: 'dispatcher' | 'technician') {
  const store = new VoiceSessionStore({ startInterval: false });
  const bus = new AgentEventBus();
  cleanups.push(() => {
    bus.unsubscribeAll();
    store.dispose();
  });
  const userRepo = new InMemoryUserRepository();
  await userRepo.create({
    id: BACKUP_ID,
    tenantId: TENANT,
    clerkUserId: BACKUP_SUBJECT,
    email: 'backup@example.com',
    role,
    canFieldServe: role === 'technician',
    mobileNumber: BACKUP_MOBILE,
  } as never);
  const settingsRepo = {
    findByTenant: async (t: string) =>
      t === TENANT ? { tenantId: TENANT, ownerPhone: OWNER_PHONE, backupSupervisorUserId: BACKUP_ID } : null,
  } as unknown as SettingsRepository;
  const { gateway, provider } = createMockLLMGateway();
  provider.setDefaultResponse(
    JSON.stringify({
      intentType: 'approve_proposal',
      confidence: 0.95,
      reasoning: 'test',
      extractedEntities: { proposalReference: 'the Henderson estimate' },
    }),
  );
  const proposalRepo = new InMemoryProposalRepository();
  const driver = new TextModeDriver({
    voiceSessionStore: store,
    bus,
    gateway,
    proposalRepo,
    auditRepo: new InMemoryAuditRepository(),
    customerRepo: new InMemoryCustomerRepository(),
    settingsRepo,
    userRepo,
    systemActorId: 'system:vq-test',
  });
  return { store, driver, proposalRepo };
}

async function seedEstimate(repo: InMemoryProposalRepository): Promise<Proposal> {
  const p = createProposal({
    tenantId: TENANT,
    proposalType: 'draft_estimate',
    payload: {
      customerName: 'Henderson Family LLC',
      lineItems: [{ description: 'Labor', category: 'labor', quantity: 1, unitPrice: 11500 }],
    },
    summary: 'Estimate for Henderson — condenser',
    createdBy: 'voice',
  });
  await repo.create(p);
  await repo.updateStatus(TENANT, p.id, 'ready_for_review');
  return (await repo.findById(TENANT, p.id))!;
}

describe('B1 follow-up — TextModeDriver carries the resolved approver (production parity)', () => {
  it("a dispatcher backup's call carries their role and approves as them, not as owner", async () => {
    const h = await build('dispatcher');
    const proposal = await seedEstimate(h.proposalRepo);
    const { sessionId } = await h.driver.startSession({ tenantId: TENANT, callerId: BACKUP_MOBILE, callerIdBlocked: false });

    await h.driver.speak(sessionId, 'approve the Henderson estimate');
    await h.driver.speak(sessionId, 'yes');

    const stored = (await h.proposalRepo.findById(TENANT, proposal.id))!;
    expect(stored.status).toBe('approved');
    expect(stored.executedByRole).toBe('dispatcher');
    expect(stored.executedBy).toBe(BACKUP_SUBJECT);
    expect(h.store.get(sessionId)?.ownerLineApprover).toEqual({ role: 'dispatcher', userId: BACKUP_SUBJECT });
  });

  it('a technician backup is recognised but approves nothing', async () => {
    const h = await build('technician');
    const proposal = await seedEstimate(h.proposalRepo);
    const { sessionId } = await h.driver.startSession({ tenantId: TENANT, callerId: BACKUP_MOBILE, callerIdBlocked: false });

    const answer = await h.driver.speak(sessionId, 'approve the Henderson estimate');
    await h.driver.speak(sessionId, 'yes');

    expect((await h.proposalRepo.findById(TENANT, proposal.id))?.status).toBe('ready_for_review');
    expect(answer.agentResponse).toContain('take approvals on this line');
    expect(h.store.get(sessionId)?.ownerLineApprover).toEqual({ role: 'technician', userId: BACKUP_SUBJECT });
  });

  it('the owner phone carries the owner; an explicit owner fixture with no caller-ID match carries none', async () => {
    const h = await build('dispatcher');
    const owner = await h.driver.startSession({ tenantId: TENANT, callerId: OWNER_PHONE, callerIdBlocked: false });
    expect(h.store.get(owner.sessionId)?.ownerLineApprover).toEqual({ role: 'owner' });

    const fixture = await h.driver.startSession({
      tenantId: TENANT,
      callerId: '+19998887777',
      callerIdBlocked: false,
      callerIsOwner: true,
    });
    expect(h.store.snapshot(fixture.sessionId)?.context.ownerSession).toBe(true);
    expect(h.store.get(fixture.sessionId)?.ownerLineApprover).toBeUndefined();
  });
});
