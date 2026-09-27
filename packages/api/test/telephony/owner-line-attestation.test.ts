/**
 * #1223 — owner-line authority is gated on STIR/SHAKEN attestation.
 *
 * Caller-ID is spoofable. A caller-ID match against the approver set
 * (owner_phone / backup supervisor mobile) only grants owner-line treatment
 * when Twilio reports full attestation (`StirVerstat=TN-Validation-Passed-A`).
 * On B/C, a failed validation, or no attestation at all, the call is an
 * untrusted caller: no ownerSession, no phone actor, the S1 caller profile
 * (fenced classifier input), and a spoken "use the app for owner actions".
 */
import { describe, it, expect, vi } from 'vitest';
import { TwilioGatherAdapter } from '../../src/telephony/twilio-adapter';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';
import type { SettingsRepository } from '../../src/settings/settings';
import type { User, UserRepository } from '../../src/users/user';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { classifierProfileForSession } from '../../src/ai/voice-turn/create-voice-turn-processor';
import { isOwnerLineAttested } from '../../src/telephony/stir-attestation';

const TENANT = 't-attest';
const OWNER_PHONE = '+15125550100';
const TECH_MOBILE = '+15125550222';
const TO = '+15125550000';
const A = 'TN-Validation-Passed-A';

function settingsRepo(): SettingsRepository {
  return { findByTenant: async () => ({ ownerPhone: OWNER_PHONE }) } as unknown as SettingsRepository;
}

function usersRepo(users: Array<Partial<User> & Pick<User, 'id' | 'role'>>): UserRepository {
  const rows = users.map((u) => ({ tenantId: TENANT, email: `${u.id}@x.io`, ...u })) as User[];
  return {
    findById: async (t: string, id: string) => rows.find((u) => u.tenantId === t && u.id === id) ?? null,
    findByMobileNumber: async (t: string, e164: string) =>
      rows.find((u) => u.tenantId === t && u.mobileNumber === e164) ?? null,
    findByTenant: async (t: string, o?: { role?: string }) =>
      rows.filter((u) => u.tenantId === t && (!o?.role || u.role === o.role)),
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

function makeAdapter() {
  const store = new VoiceSessionStore({ startInterval: false });
  const auditRepo = new InMemoryAuditRepository();
  const adapter = new TwilioGatherAdapter({
    store,
    gateway: makeGateway(),
    businessName: 'Acme Plumbing',
    publicBaseUrl: 'https://example.com',
    settingsRepo: settingsRepo(),
    userRepo: usersRepo([
      { id: 'u-owner', role: 'owner', clerkUserId: 'clerk-owner' },
      { id: 'u-tech', role: 'technician', clerkUserId: 'clerk-tech', mobileNumber: TECH_MOBILE },
    ]),
    auditRepo,
  });
  return { adapter, store, auditRepo };
}

describe('#1223 — isOwnerLineAttested', () => {
  it('accepts only full (A) attestation', () => {
    expect(isOwnerLineAttested('TN-Validation-Passed-A')).toBe(true);
    for (const v of [
      'TN-Validation-Passed-B',
      'TN-Validation-Passed-C',
      'TN-Validation-Failed-A',
      'TN-Validation-Failed',
      'No-TN-Validation',
      'tn-validation-passed-a ',
      '',
      undefined,
    ]) {
      expect(isOwnerLineAttested(v)).toBe(false);
    }
  });
});

describe('#1223 — owner line requires A-attestation (Gather)', () => {
  it('an A-attested owner number keeps owner treatment', async () => {
    const { adapter, store } = makeAdapter();
    await adapter.handleInbound({ callSid: 'CA-a', from: OWNER_PHONE, to: TO, tenantId: TENANT, stirVerstat: A });
    const s = store.findByCallSid('CA-a')!;
    expect(s.machine.currentContext.ownerSession).toBe(true);
    expect(s.actorUserId).toBe('clerk-owner');
    expect(classifierProfileForSession(s)).toBe('owner_line');
  });

  it.each(['TN-Validation-Passed-B', 'TN-Validation-Passed-C', 'TN-Validation-Failed-A', undefined])(
    'a spoofable owner number (StirVerstat=%s) gets caller treatment',
    async (verstat) => {
      const { adapter, store } = makeAdapter();
      const callSid = `CA-${verstat ?? 'none'}`;
      const twiml = await adapter.handleInbound({
        callSid,
        from: OWNER_PHONE,
        to: TO,
        tenantId: TENANT,
        ...(verstat ? { stirVerstat: verstat } : {}),
      });
      const s = store.findByCallSid(callSid)!;
      expect(s.machine.currentContext.ownerSession).toBeUndefined();
      expect(s.machine.currentContext.extendedIntents).toBeUndefined();
      expect(s.actorUserId).toBeUndefined();
      expect(classifierProfileForSession(s)).toBe('caller');
      // Spoken notice: owner actions go through the app on this call.
      expect(twiml).toContain('use the app');
    },
  );

  it('a customer caller hears no owner notice', async () => {
    const { adapter } = makeAdapter();
    const twiml = await adapter.handleInbound({
      callSid: 'CA-cust',
      from: '+15125559999',
      to: TO,
      tenantId: TENANT,
    });
    expect(twiml).not.toContain('use the app');
  });

  it('a technician mobile without A-attestation resolves no phone actor', async () => {
    const { adapter, store } = makeAdapter();
    await adapter.handleInbound({
      callSid: 'CA-tech-b',
      from: TECH_MOBILE,
      to: TO,
      tenantId: TENANT,
      stirVerstat: 'TN-Validation-Passed-B',
    });
    expect(store.findByCallSid('CA-tech-b')!.actorUserId).toBeUndefined();
  });

  it('a technician mobile with A-attestation keeps its actor', async () => {
    const { adapter, store } = makeAdapter();
    await adapter.handleInbound({ callSid: 'CA-tech-a', from: TECH_MOBILE, to: TO, tenantId: TENANT, stirVerstat: A });
    expect(store.findByCallSid('CA-tech-a')!.actorUserId).toBe('clerk-tech');
  });

  it('audits the attestation decision when the caller-ID matches an approver', async () => {
    const { adapter, store, auditRepo } = makeAdapter();
    await adapter.handleInbound({
      callSid: 'CA-audit',
      from: OWNER_PHONE,
      to: TO,
      tenantId: TENANT,
      stirVerstat: 'TN-Validation-Passed-B',
    });
    const s = store.findByCallSid('CA-audit')!;
    await vi.waitFor(async () => {
      const events = await auditRepo.findByEntity(TENANT, 'voice_session', s.id);
      const ev = events.find((e) => e.eventType === 'voice.owner_line_attestation');
      expect(ev).toBeDefined();
      expect(ev!.metadata).toMatchObject({ stirVerstat: 'TN-Validation-Passed-B', ownerSession: false });
    });
  });
});

describe('#1223 — owner line requires A-attestation (Media Streams)', () => {
  it('stream: B-attested owner number is a caller; A-attested is the owner', async () => {
    const { adapter, store } = makeAdapter();
    await adapter.handleInboundForStream({
      callSid: 'CA-s-b',
      from: OWNER_PHONE,
      tenantId: TENANT,
      stirVerstat: 'TN-Validation-Passed-B',
    });
    await adapter.handleInboundForStream({ callSid: 'CA-s-a', from: OWNER_PHONE, tenantId: TENANT, stirVerstat: A });
    expect(store.findByCallSid('CA-s-b')!.machine.currentContext.ownerSession).toBeUndefined();
    expect(store.findByCallSid('CA-s-a')!.machine.currentContext.ownerSession).toBe(true);
  });
});
