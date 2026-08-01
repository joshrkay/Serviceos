/**
 * WS21b — TextModeDriver reaches the REAL owner voice-approval dialogue.
 *
 * The voice-action-router worker refuses approve/reject/edit intents, so
 * before WS21b the harness could never grade an approval conversation. These
 * tests prove the driver now:
 *   - stamps RV-070 ownerSession from an owner-phone caller-ID match AND from
 *     an explicit callerIsOwner flag (and withholds it from a stranger),
 *   - routes an owner "approve …" through the production
 *     handleVoiceApprovalIntent → readback → strict confirm → hashed-PIN
 *     challenge → approval (the seeded proposal flips to approved),
 *   - hard-denies a non-owner "approve …" (proposal stays pending).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import { AgentEventBus } from '../../src/ai/voice-quality/event-bus';
import { TextModeDriver } from '../../src/ai/voice-quality/text-mode-driver';
import { createMockLLMGateway } from '../../src/ai/gateway/factory';
import {
  InMemoryProposalRepository,
  createProposal,
  type Proposal,
} from '../../src/proposals/proposal';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import type { SettingsRepository } from '../../src/settings/settings';
import { hashVoiceApprovalPin, normalizeEnrollmentPin } from '../../src/settings/voice-approval-pin';

const TENANT = 't-ws21b';
const OWNER_PHONE = '+15125550100';
const PIN = '4271';
const KEY = 'unit-test-enc-key';

function approveClassifyJson(): string {
  return JSON.stringify({
    intentType: 'approve_proposal',
    confidence: 0.95,
    reasoning: 'test',
    extractedEntities: { proposalReference: 'the Acme payment' },
  });
}

function settingsStub(withPin: boolean): SettingsRepository {
  return {
    findByTenant: async (t: string) =>
      t === TENANT
        ? ({
            tenantId: TENANT,
            ownerPhone: OWNER_PHONE,
            ...(withPin
              ? {
                  escalationSettings: {
                    voice_approval_pin_hash: hashVoiceApprovalPin(
                      normalizeEnrollmentPin(PIN),
                      TENANT,
                      KEY,
                    ),
                  },
                }
              : {}),
          } as never)
        : null,
  } as unknown as SettingsRepository;
}

function build(opts: { withPin?: boolean } = {}) {
  const store = new VoiceSessionStore({ startInterval: false });
  const bus = new AgentEventBus();
  const { gateway, provider } = createMockLLMGateway();
  provider.setDefaultResponse(approveClassifyJson());
  const proposalRepo = new InMemoryProposalRepository();
  const auditRepo = new InMemoryAuditRepository();
  const driver = new TextModeDriver({
    voiceSessionStore: store,
    bus,
    gateway,
    proposalRepo,
    auditRepo,
    settingsRepo: settingsStub(opts.withPin ?? true),
    systemActorId: 'system:vq-test',
  });
  return { store, bus, driver, provider, proposalRepo };
}

async function seedMoneyProposal(repo: InMemoryProposalRepository): Promise<Proposal> {
  const p = createProposal({
    tenantId: TENANT,
    proposalType: 'record_payment',
    payload: { customerName: 'Acme Corp', amountCents: 20000 },
    summary: 'Record $200 payment from Acme',
    createdBy: 'user-1',
  });
  await repo.create(p);
  await repo.updateStatus(TENANT, p.id, 'ready_for_review');
  return (await repo.findById(TENANT, p.id))!;
}

describe('WS21b — TextModeDriver owner voice approval', () => {
  const prevKey = process.env.TENANT_ENCRYPTION_KEY;
  let h: ReturnType<typeof build>;

  beforeEach(() => {
    process.env.TENANT_ENCRYPTION_KEY = KEY;
    h = build();
  });
  afterEach(() => {
    h.bus.unsubscribeAll();
    h.store.dispose();
    if (prevKey === undefined) delete process.env.TENANT_ENCRYPTION_KEY;
    else process.env.TENANT_ENCRYPTION_KEY = prevKey;
  });

  it('stamps ownerSession when the caller-ID matches the tenant owner phone', async () => {
    const { sessionId } = await h.driver.startSession({
      tenantId: TENANT,
      callerId: OWNER_PHONE,
      callerIdBlocked: false,
    });
    const snap = h.store.snapshot(sessionId);
    expect(snap?.context.ownerSession).toBe(true);
  });

  it('stamps ownerSession from an explicit callerIsOwner flag (no phone match needed)', async () => {
    const { sessionId } = await h.driver.startSession({
      tenantId: TENANT,
      callerId: '+19998887777',
      callerIdBlocked: false,
      callerIsOwner: true,
    });
    expect(h.store.snapshot(sessionId)?.context.ownerSession).toBe(true);
  });

  it('withholds ownerSession from a non-owner caller', async () => {
    const { sessionId } = await h.driver.startSession({
      tenantId: TENANT,
      callerId: '+19998887777',
      callerIdBlocked: false,
    });
    expect(h.store.snapshot(sessionId)?.context.ownerSession ?? false).toBe(false);
  });

  it('owner approval reaches the real dialogue: readback → confirm → PIN → approved', async () => {
    const proposal = await seedMoneyProposal(h.proposalRepo);
    const { sessionId } = await h.driver.startSession({
      tenantId: TENANT,
      callerId: OWNER_PHONE,
      callerIdBlocked: false,
    });

    const readback = await h.driver.speak(sessionId, 'approve the Acme payment');
    // Payload-derived readback (never the utterance) — the real dialogue ran.
    expect(readback.agentResponse.toLowerCase()).toContain('acme');
    expect((await h.proposalRepo.findById(TENANT, proposal.id))?.status).toBe('ready_for_review');

    const challengePrompt = await h.driver.speak(sessionId, 'yes, approve it');
    // Money class → asks for the approval code before acting.
    expect(challengePrompt.agentResponse.toLowerCase()).toContain('code');
    expect((await h.proposalRepo.findById(TENANT, proposal.id))?.status).toBe('ready_for_review');

    const done = await h.driver.speak(sessionId, 'four two seven one');
    expect((await h.proposalRepo.findById(TENANT, proposal.id))?.status).toBe('approved');
    expect(done.agentResponse.length).toBeGreaterThan(0);
  });

  it('wrong PIN keeps the proposal pending (challenge fails, dialogue continues)', async () => {
    const proposal = await seedMoneyProposal(h.proposalRepo);
    const { sessionId } = await h.driver.startSession({
      tenantId: TENANT,
      callerId: OWNER_PHONE,
      callerIdBlocked: false,
    });
    await h.driver.speak(sessionId, 'approve the Acme payment');
    await h.driver.speak(sessionId, 'yes');
    const failed = await h.driver.speak(sessionId, 'nine nine nine nine');
    expect(failed.agentResponse.toLowerCase()).toMatch(/did.?n.?t match/);
    expect((await h.proposalRepo.findById(TENANT, proposal.id))?.status).toBe('ready_for_review');
  });

  it('non-owner "approve" is hard-denied — the proposal never approves', async () => {
    const proposal = await seedMoneyProposal(h.proposalRepo);
    const { sessionId } = await h.driver.startSession({
      tenantId: TENANT,
      callerId: '+19998887777', // not the owner phone
      callerIdBlocked: false,
    });
    await h.driver.speak(sessionId, 'approve the Acme payment');
    expect((await h.proposalRepo.findById(TENANT, proposal.id))?.status).toBe('ready_for_review');
    // A follow-up "yes" must not resume any approval dialogue either.
    await h.driver.speak(sessionId, 'yes');
    expect((await h.proposalRepo.findById(TENANT, proposal.id))?.status).toBe('ready_for_review');
  });
});
