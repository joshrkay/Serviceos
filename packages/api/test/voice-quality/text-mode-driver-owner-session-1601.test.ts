/**
 * #1601 step 2 — the Layer 1 text-mode driver resolves RV-070 owner-line
 * recognition through the SAME shared helper the Gather adapter uses.
 *
 * Divergence pinned here: the driver's own copy never threaded `userRepo`
 * into `isApproverPhone`, so a corpus call placed from the backup
 * supervisor's registered mobile was graded as a stranger while production
 * recognised it as an owner line (`test/telephony/owner-session.test.ts`
 * "recognizes the backup supervisor mobile when userRepo is wired"). The
 * shared helper closes that gap; the fixture `callerIsOwner` short-circuit
 * and the fail-closed rule are unchanged.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import { AgentEventBus } from '../../src/ai/voice-quality/event-bus';
import { TextModeDriver } from '../../src/ai/voice-quality/text-mode-driver';
import { createMockLLMGateway } from '../../src/ai/gateway/factory';
import { InMemoryProposalRepository } from '../../src/proposals/proposal';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemoryCustomerRepository } from '../../src/customers/customer';
import { InMemoryUserRepository } from '../../src/users/user';
import type { SettingsRepository } from '../../src/settings/settings';

const TENANT = 't-1601-owner-driver';
const OWNER_PHONE = '+15125550100';
const BACKUP_MOBILE = '+15125550111';
const STRANGER = '+19998887777';

const stores: VoiceSessionStore[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.dispose();
});

async function build(opts: { withUserRepo: boolean; settingsThrow?: boolean }) {
  const store = new VoiceSessionStore({ startInterval: false });
  stores.push(store);
  const userRepo = new InMemoryUserRepository();
  const backup = await userRepo.create({
    id: 'user-backup-1601',
    tenantId: TENANT,
    email: 'backup@example.com',
    role: 'dispatcher',
    canFieldServe: false,
    mobileNumber: BACKUP_MOBILE,
  } as never);
  const settingsRepo = {
    findByTenant: async () => {
      if (opts.settingsThrow) throw new Error('pg down');
      return { tenantId: TENANT, ownerPhone: OWNER_PHONE, backupSupervisorUserId: backup.id };
    },
  } as unknown as SettingsRepository;
  const { gateway, provider } = createMockLLMGateway();
  provider.setDefaultResponse(
    JSON.stringify({ intentType: 'unknown', confidence: 0, reasoning: 'x', extractedEntities: {} }),
  );
  const driver = new TextModeDriver({
    voiceSessionStore: store,
    bus: new AgentEventBus(),
    gateway,
    proposalRepo: new InMemoryProposalRepository(),
    auditRepo: new InMemoryAuditRepository(),
    customerRepo: new InMemoryCustomerRepository(),
    settingsRepo,
    ...(opts.withUserRepo ? { userRepo } : {}),
    systemActorId: 'system:vq-test',
  });
  const ownerSessionFor = async (callerId: string) => {
    const { sessionId } = await driver.startSession({ tenantId: TENANT, callerId, callerIdBlocked: false });
    return store.snapshot(sessionId)?.context.ownerSession ?? false;
  };
  return { ownerSessionFor };
}

describe('#1601 — TextModeDriver owner-line recognition (shared with the Gather adapter)', () => {
  it('the backup supervisor mobile is an owner line when a userRepo is wired (production parity)', async () => {
    const h = await build({ withUserRepo: true });
    expect(await h.ownerSessionFor(BACKUP_MOBILE)).toBe(true);
  });

  it('without a userRepo only the owner phone is recognised', async () => {
    const h = await build({ withUserRepo: false });
    expect(await h.ownerSessionFor(OWNER_PHONE)).toBe(true);
    expect(await h.ownerSessionFor(BACKUP_MOBILE)).toBe(false);
  });

  it('fails closed: a stranger, and any caller when the settings read fails', async () => {
    const h = await build({ withUserRepo: true });
    expect(await h.ownerSessionFor(STRANGER)).toBe(false);
    const broken = await build({ withUserRepo: true, settingsThrow: true });
    expect(await broken.ownerSessionFor(OWNER_PHONE)).toBe(false);
  });
});
