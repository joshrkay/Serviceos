/**
 * RV-070 — owner-line recognition.
 *
 * When the inbound caller-ID matches `tenant_settings.owner_phone` (or the
 * backup supervisor's mobile), the FSM session context gets
 * `ownerSession: true`. Identity is the verified caller-ID with the same
 * normalization as the SMS reply transport (`proposals/approver-identity.ts`)
 * — never utterance content. Everything else about the session is
 * unchanged (the transition table never reads the flag).
 */
import { describe, it, expect, vi } from 'vitest';
import { TwilioGatherAdapter } from '../../src/telephony/twilio-adapter';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';
import type { SettingsRepository, TenantSettings } from '../../src/settings/settings';
import type { UserRepository } from '../../src/users/user';
import type { User } from '../../src/users/user';
import {
  resolveApproverPhones,
  isApprover,
  isApproverPhone,
} from '../../src/proposals/approver-identity';

const TENANT = 't-owner';
const OWNER_PHONE = '+15125550100';
const CUSTOMER_PHONE = '+15125559999';
const BACKUP_USER_ID = 'user-backup';
const BACKUP_MOBILE = '+15125550111';

function stubSettingsRepo(
  overrides: Partial<TenantSettings> = {},
): SettingsRepository {
  return {
    findByTenant: async () => ({ ownerPhone: OWNER_PHONE, ...overrides }),
  } as unknown as SettingsRepository;
}

function stubUserRepo(): UserRepository {
  const row = { id: BACKUP_USER_ID, tenantId: TENANT, mobileNumber: BACKUP_MOBILE };
  return {
    findById: async (tenantId: string, id: string) =>
      tenantId === TENANT && id === BACKUP_USER_ID ? row : null,
    findByMobileNumber: async (tenantId: string, e164: string) =>
      tenantId === TENANT && e164 === BACKUP_MOBILE ? row : null,
    findByTenant: async (tenantId: string) => (tenantId === TENANT ? [row] : []),
  } as unknown as UserRepository;
}

function makeGateway(): LLMGateway {
  const response: LLMResponse = {
    content: '{"intentType":"unknown","confidence":0,"reasoning":"x"}',
    model: 'mock-model',
    provider: 'mock',
    tokenUsage: { input: 1, output: 1, total: 2 },
    latencyMs: 1,
  };
  return { complete: vi.fn().mockResolvedValue(response) } as unknown as LLMGateway;
}

function makeAdapter(opts: {
  settingsRepo?: SettingsRepository;
  userRepo?: UserRepository;
} = {}) {
  const store = new VoiceSessionStore({ startInterval: false });
  const adapter = new TwilioGatherAdapter({
    store,
    gateway: makeGateway(),
    businessName: 'Acme Plumbing',
    publicBaseUrl: 'https://example.com',
    ...(opts.settingsRepo ? { settingsRepo: opts.settingsRepo } : {}),
    ...(opts.userRepo ? { userRepo: opts.userRepo } : {}),
  });
  return { adapter, store };
}

describe('RV-070 — owner-line recognition (Gather inbound)', () => {
  it('sets ownerSession: true when the caller-ID matches owner_phone exactly', async () => {
    const { adapter, store } = makeAdapter({ settingsRepo: stubSettingsRepo() });

    await adapter.handleInbound({
      callSid: 'CA-owner-1',
      from: OWNER_PHONE,
      to: '+15125550000',
      tenantId: TENANT,
    });

    const session = store.findByCallSid('CA-owner-1')!;
    expect(session.machine.currentContext.ownerSession).toBe(true);
  });

  it.each([
    '+1 (512) 555-0100', // formatted
    '15125550100', // 11-digit, no plus
    '5125550100', // 10-digit local
  ])('normalizes caller-ID variant %s to the owner phone', async (variant) => {
    const { adapter, store } = makeAdapter({ settingsRepo: stubSettingsRepo() });

    await adapter.handleInbound({
      callSid: `CA-${variant.replace(/\D/g, '')}`,
      from: variant,
      to: '+15125550000',
      tenantId: TENANT,
    });

    const session = store.findByCallSid(`CA-${variant.replace(/\D/g, '')}`)!;
    expect(session.machine.currentContext.ownerSession).toBe(true);
  });

  it('does NOT set ownerSession for a customer phone', async () => {
    const { adapter, store } = makeAdapter({ settingsRepo: stubSettingsRepo() });

    await adapter.handleInbound({
      callSid: 'CA-cust-1',
      from: CUSTOMER_PHONE,
      to: '+15125550000',
      tenantId: TENANT,
    });

    const session = store.findByCallSid('CA-cust-1')!;
    expect(session.machine.currentContext.ownerSession).toBeUndefined();
  });

  it('recognizes the backup supervisor mobile when userRepo is wired', async () => {
    const { adapter, store } = makeAdapter({
      settingsRepo: stubSettingsRepo({ backupSupervisorUserId: BACKUP_USER_ID }),
      userRepo: stubUserRepo(),
    });

    await adapter.handleInbound({
      callSid: 'CA-backup-1',
      from: BACKUP_MOBILE,
      to: '+15125550000',
      tenantId: TENANT,
    });

    const session = store.findByCallSid('CA-backup-1')!;
    expect(session.machine.currentContext.ownerSession).toBe(true);
  });

  it('ignores the backup supervisor mobile when no userRepo is wired (mirrors SMS handler)', async () => {
    const { adapter, store } = makeAdapter({
      settingsRepo: stubSettingsRepo({ backupSupervisorUserId: BACKUP_USER_ID }),
    });

    await adapter.handleInbound({
      callSid: 'CA-backup-2',
      from: BACKUP_MOBILE,
      to: '+15125550000',
      tenantId: TENANT,
    });

    const session = store.findByCallSid('CA-backup-2')!;
    expect(session.machine.currentContext.ownerSession).toBeUndefined();
  });

  it('fails closed (non-owner) when the settings lookup throws', async () => {
    const throwingRepo = {
      findByTenant: async () => {
        throw new Error('db down');
      },
    } as unknown as SettingsRepository;
    const { adapter, store } = makeAdapter({ settingsRepo: throwingRepo });

    await adapter.handleInbound({
      callSid: 'CA-err-1',
      from: OWNER_PHONE,
      to: '+15125550000',
      tenantId: TENANT,
    });

    const session = store.findByCallSid('CA-err-1')!;
    expect(session.machine.currentContext.ownerSession).toBeUndefined();
  });

  it('stays non-owner without a settingsRepo (no identity source)', async () => {
    const { adapter, store } = makeAdapter();

    await adapter.handleInbound({
      callSid: 'CA-nosettings-1',
      from: OWNER_PHONE,
      to: '+15125550000',
      tenantId: TENANT,
    });

    const session = store.findByCallSid('CA-nosettings-1')!;
    expect(session.machine.currentContext.ownerSession).toBeUndefined();
  });
});

describe('RV-070 — owner-line recognition (Media Streams inbound)', () => {
  it('sets ownerSession on the stream session creation path too', async () => {
    const { adapter, store } = makeAdapter({ settingsRepo: stubSettingsRepo() });

    await adapter.handleInboundForStream({
      callSid: 'CA-stream-owner',
      from: '1 (512) 555-0100',
      tenantId: TENANT,
    });

    const session = store.findByCallSid('CA-stream-owner')!;
    expect(session.machine.currentContext.ownerSession).toBe(true);
  });

  it('leaves ownerSession unset for unknown callers on the stream path', async () => {
    const { adapter, store } = makeAdapter({ settingsRepo: stubSettingsRepo() });

    await adapter.handleInboundForStream({
      callSid: 'CA-stream-cust',
      from: CUSTOMER_PHONE,
      tenantId: TENANT,
    });

    const session = store.findByCallSid('CA-stream-cust')!;
    expect(session.machine.currentContext.ownerSession).toBeUndefined();
  });
});

describe('RV-070 — approver-identity helper (shared with SMS transport)', () => {
  it('resolveApproverPhones returns owner phone then backup mobile', async () => {
    const phones = await resolveApproverPhones(
      {
        settingsRepo: stubSettingsRepo({ backupSupervisorUserId: BACKUP_USER_ID }),
        userRepo: stubUserRepo(),
      },
      TENANT,
    );
    expect(phones).toEqual([OWNER_PHONE, BACKUP_MOBILE]);
  });

  it('isApprover matches across normalization variants', () => {
    expect(isApprover(['+1 (512) 555-0100'], '15125550100')).toBe(true);
    expect(isApprover(['5125550100'], '+15125550100')).toBe(true);
    expect(isApprover([OWNER_PHONE], CUSTOMER_PHONE)).toBe(false);
    expect(isApprover([OWNER_PHONE], '')).toBe(false);
  });

  it('isApproverPhone returns false for missing caller-ID', async () => {
    expect(
      await isApproverPhone({ settingsRepo: stubSettingsRepo() }, TENANT, undefined),
    ).toBe(false);
    expect(
      await isApproverPhone({ settingsRepo: stubSettingsRepo() }, TENANT, ''),
    ).toBe(false);
  });
});

describe('#866 — actor stamped at session establishment (both transports share establishInboundSession)', () => {
  const TECH_MOBILE = '+15125550222';

  function usersRepo(users: Array<Partial<User> & Pick<User, 'id' | 'role'>>): UserRepository {
    const rows = users.map((u) => ({ tenantId: TENANT, canFieldServe: true, email: `${u.id}@x.io`, ...u })) as User[];
    return {
      findById: async (tenantId: string, id: string) =>
        rows.find((u) => u.tenantId === tenantId && u.id === id) ?? null,
      findByMobileNumber: async (tenantId: string, e164: string) =>
        rows.find((u) => u.tenantId === tenantId && u.mobileNumber === e164 && !u.deletedAt) ?? null,
      findByTenant: async (tenantId: string, opts?: { role?: string }) =>
        rows.filter((u) => u.tenantId === tenantId && (!opts?.role || u.role === opts.role)),
    } as unknown as UserRepository;
  }

  it('a technician calling from their registered mobile gets an actor (and no ownerSession)', async () => {
    const { adapter, store } = makeAdapter({
      settingsRepo: stubSettingsRepo(),
      userRepo: usersRepo([{ id: 'u-tech', role: 'technician', clerkUserId: 'clerk-tech', mobileNumber: TECH_MOBILE }]),
    });

    await adapter.handleInbound({ callSid: 'CA-actor-tech', from: TECH_MOBILE, to: '+15125550000', tenantId: TENANT });

    const session = store.findByCallSid('CA-actor-tech')!;
    expect(session.actorUserId).toBe('clerk-tech');
    expect(session.machine.currentContext.ownerSession).toBeUndefined();
  });

  it('the owner line with no mobile on any profile bridges to the sole owner user', async () => {
    const { adapter, store } = makeAdapter({
      settingsRepo: stubSettingsRepo(),
      userRepo: usersRepo([{ id: 'u-owner', role: 'owner', clerkUserId: 'clerk-owner' }]),
    });

    await adapter.handleInbound({ callSid: 'CA-actor-owner', from: OWNER_PHONE, to: '+15125550000', tenantId: TENANT });

    const session = store.findByCallSid('CA-actor-owner')!;
    expect(session.machine.currentContext.ownerSession).toBe(true);
    expect(session.actorUserId).toBe('clerk-owner');
  });

  it('the backup supervisor resolves through their mobile', async () => {
    const { adapter, store } = makeAdapter({
      settingsRepo: stubSettingsRepo({ backupSupervisorUserId: BACKUP_USER_ID }),
      userRepo: usersRepo([
        { id: 'u-owner', role: 'owner' },
        { id: BACKUP_USER_ID, role: 'dispatcher', clerkUserId: 'clerk-backup', mobileNumber: BACKUP_MOBILE },
      ]),
    });

    await adapter.handleInbound({ callSid: 'CA-actor-backup', from: BACKUP_MOBILE, to: '+15125550000', tenantId: TENANT });

    const session = store.findByCallSid('CA-actor-backup')!;
    expect(session.machine.currentContext.ownerSession).toBe(true);
    expect(session.actorUserId).toBe('clerk-backup');
  });

  it('a suspended backup supervisor gets NO actor even though the owner line still bridges (ownerSession unaffected)', async () => {
    const { adapter, store } = makeAdapter({
      settingsRepo: stubSettingsRepo({ backupSupervisorUserId: BACKUP_USER_ID }),
      userRepo: usersRepo([
        { id: 'u-owner', role: 'owner' },
        {
          id: BACKUP_USER_ID,
          role: 'dispatcher',
          clerkUserId: 'clerk-backup',
          mobileNumber: BACKUP_MOBILE,
          status: 'suspended',
        },
      ]),
    });

    await adapter.handleInbound({ callSid: 'CA-actor-backup-suspended', from: BACKUP_MOBILE, to: '+15125550000', tenantId: TENANT });

    const session = store.findByCallSid('CA-actor-backup-suspended')!;
    expect(session.machine.currentContext.ownerSession).toBe(true);
    expect(session.actorUserId).toBeUndefined();
  });

  it('a customer number gets no actor', async () => {
    const { adapter, store } = makeAdapter({
      settingsRepo: stubSettingsRepo(),
      userRepo: usersRepo([{ id: 'u-owner', role: 'owner' }]),
    });

    await adapter.handleInbound({ callSid: 'CA-actor-cust', from: CUSTOMER_PHONE, to: '+15125550000', tenantId: TENANT });

    expect(store.findByCallSid('CA-actor-cust')!.actorUserId).toBeUndefined();
  });

  it('a Twilio replay of the same CallSid keeps the actor already stamped', async () => {
    const userRepo = usersRepo([{ id: 'u-tech', role: 'technician', mobileNumber: TECH_MOBILE }]);
    const findByMobileNumberSpy = vi.spyOn(userRepo, 'findByMobileNumber');
    const { adapter, store } = makeAdapter({
      settingsRepo: stubSettingsRepo(),
      userRepo,
    });
    await adapter.handleInbound({ callSid: 'CA-actor-replay', from: TECH_MOBILE, to: '+15125550000', tenantId: TENANT });
    await adapter.handleInbound({ callSid: 'CA-actor-replay', from: TECH_MOBILE, to: '+15125550000', tenantId: TENANT });

    expect(store.findByCallSid('CA-actor-replay')!.actorUserId).toBe('u-tech');
    // Proves the replay took the early-return path in establishInboundSession
    // rather than re-running actor resolution (and thus never re-hitting the
    // repo on the second webhook retry).
    expect(findByMobileNumberSpy).toHaveBeenCalledTimes(1);
  });

  it('the Media Streams transport stamps the actor too (both transports share establishInboundSession)', async () => {
    const { adapter, store } = makeAdapter({
      settingsRepo: stubSettingsRepo(),
      userRepo: usersRepo([{ id: 'u-tech', role: 'technician', clerkUserId: 'clerk-tech', mobileNumber: TECH_MOBILE }]),
    });

    await adapter.handleInboundForStream({ callSid: 'CA-actor-stream-tech', from: TECH_MOBILE, tenantId: TENANT });

    expect(store.findByCallSid('CA-actor-stream-tech')!.actorUserId).toBe('clerk-tech');
  });
});
