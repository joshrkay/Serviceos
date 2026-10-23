/**
 * B4-1 — a backup supervisor's line is authorised as that backup, never as
 * the owner.
 *
 * Two lookups decide who a caller is at pick-up. `resolveApproverRole`
 * recognises the owner line and compares phones with `normalizePhone`, so a
 * backup whose stored mobile is '(512) 555-0111' is recognised on a call from
 * '+15125550111'. `resolvePhoneActor` picked the phone actor (the subject
 * every owner lookup is authorised by) with an exact E.164 match, missed that
 * backup, and fell back to the tenant's single owner: the backup's lookups
 * were authorised as the OWNER. A technician backup heard the owner digest.
 *
 * The actor lookup now compares phones the same way on an owner line, and a
 * line that resolved to the backup is authorised as that backup or as nobody.
 * The owner phone keeps its bridge to the single owner.
 *
 * Handler level, end to end through the Gather adapter, with the in-memory
 * users repository (exact-match `findByMobileNumber`, like the Postgres one).
 */
import { describe, it, expect, vi } from 'vitest';
import { TwilioGatherAdapter } from '../../src/telephony/twilio-adapter';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import type { LLMGateway, LLMRequest, LLMResponse } from '../../src/ai/gateway/gateway';
import { InMemoryProposalRepository } from '../../src/proposals/proposal';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import type { SettingsRepository } from '../../src/settings/settings';
import { InMemoryUserRepository, type User } from '../../src/users/user';
import { InMemoryAppointmentRepository } from '../../src/appointments/in-memory-appointment';
import { InMemoryJobRepository } from '../../src/jobs/job';
import { InMemoryDailyDigestRepository } from '../../src/digest/digest-service';
import { InMemoryEstimateRepository } from '../../src/estimates/estimate';
import { InMemoryInvoiceRepository } from '../../src/invoices/invoice';
import { InMemoryDroppedCallRecoveryRepository } from '../../src/sms/recovery/scheduler';

const TENANT = 't-backup-actor';
const OWNER_PHONE = '+15125550100';
const CALLER_ID = '+15125550111';
const BACKUP_ID = 'user-backup-actor';
const DIGEST_ASK = 'question two please';
const DIGEST_TEXT = 'Owner digest: revenue was strong';
const OWNER_REFUSAL = 'owner-level report';

function digestGateway(): LLMGateway {
  return {
    complete: vi.fn(async (req: LLMRequest) => {
      const last = String(req.messages[req.messages.length - 1]?.content ?? '');
      const content = JSON.stringify(
        last.includes(DIGEST_ASK)
          ? { intentType: 'lookup_digest', confidence: 0.96 }
          : { intentType: 'unknown', confidence: 0.2 },
      );
      return {
        content,
        model: 'mock',
        provider: 'mock',
        tokenUsage: { input: 5, output: 5, total: 10 },
        latencyMs: 1,
      } satisfies LLMResponse;
    }),
  } as unknown as LLMGateway;
}

async function harness(opts: { backupRole: User['role']; backupMobile: string; others?: Array<Partial<User> & Pick<User, 'id' | 'role'>> }) {
  const userRepo = new InMemoryUserRepository();
  const seed = (u: Partial<User> & Pick<User, 'id' | 'role'>) =>
    userRepo.create!({ tenantId: TENANT, email: `${u.id}@example.com`, canFieldServe: true, ...u });
  // The owner has no mobile on their profile: owner_phone in settings is their line.
  await seed({ id: 'u-owner', role: 'owner', clerkUserId: 'clerk-owner' });
  await seed({ id: BACKUP_ID, role: opts.backupRole, clerkUserId: 'clerk-backup-actor', mobileNumber: opts.backupMobile });
  for (const other of opts.others ?? []) await seed(other);

  const settingsRepo = {
    findByTenant: async () => ({ ownerPhone: OWNER_PHONE, backupSupervisorUserId: BACKUP_ID, escalationSettings: {} }),
  } as unknown as SettingsRepository;

  const dailyDigestRepo = new InMemoryDailyDigestRepository();
  await dailyDigestRepo.upsert(
    TENANT,
    new Date().toISOString().slice(0, 10),
    {} as Parameters<InMemoryDailyDigestRepository['upsert']>[2],
    DIGEST_TEXT,
  );
  const appointmentRepo = new InMemoryAppointmentRepository();
  const jobRepo = new InMemoryJobRepository();
  const proposalRepo = new InMemoryProposalRepository();
  const estimateRepo = new InMemoryEstimateRepository();
  const invoiceRepo = new InMemoryInvoiceRepository();

  const store = new VoiceSessionStore({ startInterval: false });
  const adapter = new TwilioGatherAdapter({
    store,
    gateway: digestGateway(),
    businessName: 'Acme Plumbing',
    publicBaseUrl: 'https://example.com',
    proposalRepo,
    auditRepo: new InMemoryAuditRepository(),
    settingsRepo,
    userRepo,
    appointmentRepo,
    jobRepo,
    estimateRepo,
    invoiceRepo,
    extendedIntentsEnabled: async () => true,
    lookups: {
      answers: {
        dailyDigestRepo,
        estimateRepo,
        invoiceRepo,
        droppedCallRecoveryRepo: new InMemoryDroppedCallRecoveryRepository(),
        // Production's Postgres loader: keyed on the Clerk subject; an
        // inactive member has no role.
        resolveMemberRole: async (t: string, subject: string) => {
          const u = (await userRepo.findByTenant(t)).find((x) => x.clerkUserId === subject);
          return u && (u.status ?? 'active') === 'active' ? u.role : null;
        },
      },
      shared: { appointmentRepo, jobRepo, proposalRepo },
    } as never,
  });

  async function call(from: string, callSid: string) {
    // #1223 — the owner line is only trusted when fully (A) attested.
    await adapter.handleInbound({ callSid, from, to: '+15125550000', tenantId: TENANT, stirVerstat: 'TN-Validation-Passed-A' });
    const session = store.findByCallSid(callSid)!;
    // Without a DB pool the caller lands in ask_caller; emulate the
    // identified-caller transition so handleGather classifies.
    session.machine.dispatch({ type: 'caller_known', customerId: 'cust-1' });
    return session;
  }
  const askDigest = (sessionId: string, callSid: string) =>
    adapter.handleGather({ sessionId, callSid, speechResult: DIGEST_ASK, confidence: 0.95, tenantId: TENANT });

  return { call, askDigest };
}

const STORED_FORMATS = ['(512) 555-0111', '15125550111', '512-555-0111', '+1 512 555 0111'];

describe('B4-1 — a backup whose stored mobile is formatted differently is their own actor', () => {
  it.each(STORED_FORMATS)('a technician backup stored as %s is refused the owner digest', async (stored) => {
    const h = await harness({ backupRole: 'technician', backupMobile: stored });
    const session = await h.call(CALLER_ID, `CA-tech-${stored.replace(/\W+/g, '')}`);

    // Recognised as the backup line (the approver lookup normalises)…
    expect(session.ownerLineApprover).toMatchObject({ role: 'technician', userId: 'clerk-backup-actor' });
    // …and authorised as that backup, not the owner.
    expect(session.actorUserId).toBe('clerk-backup-actor');

    const xml = await h.askDigest(session.id, `CA-tech-${stored.replace(/\W+/g, '')}`);
    expect(xml).toContain(OWNER_REFUSAL);
    expect(xml).not.toContain(DIGEST_TEXT);
  });

  it.each(STORED_FORMATS)('a dispatcher backup stored as %s is authorised as the dispatcher', async (stored) => {
    const h = await harness({ backupRole: 'dispatcher', backupMobile: stored });
    const session = await h.call(CALLER_ID, `CA-disp-${stored.replace(/\W+/g, '')}`);

    expect(session.actorUserId).toBe('clerk-backup-actor');
    expect(await h.askDigest(session.id, `CA-disp-${stored.replace(/\W+/g, '')}`)).toContain(DIGEST_TEXT);
  });
});

describe('B4-1 — a backup line is authorised as that backup or as nobody', () => {
  it("never as the owner: two teammates' mobiles both read as the caller-ID", async () => {
    const h = await harness({
      backupRole: 'technician',
      backupMobile: '(512) 555-0111',
      others: [{ id: 'u-tech-2', role: 'technician', clerkUserId: 'clerk-tech-2', mobileNumber: '512.555.0111' }],
    });
    const session = await h.call(CALLER_ID, 'CA-ambiguous');

    expect(session.ownerLineApprover).toMatchObject({ role: 'technician' });
    expect(session.actorUserId).toBeUndefined();
    const xml = await h.askDigest(session.id, 'CA-ambiguous');
    expect(xml).toContain(OWNER_REFUSAL);
    expect(xml).not.toContain(DIGEST_TEXT);
  });

  it('never as another teammate whose mobile matches the caller-ID exactly', async () => {
    const h = await harness({
      backupRole: 'technician',
      backupMobile: '(512) 555-0111',
      others: [{ id: 'u-disp-2', role: 'dispatcher', clerkUserId: 'clerk-disp-2', mobileNumber: CALLER_ID }],
    });
    const session = await h.call(CALLER_ID, 'CA-someone-else');

    expect(session.ownerLineApprover).toMatchObject({ role: 'technician', userId: 'clerk-backup-actor' });
    expect(session.actorUserId).toBeUndefined();
    expect(await h.askDigest(session.id, 'CA-someone-else')).not.toContain(DIGEST_TEXT);
  });

  it('the owner phone still bridges to the single owner', async () => {
    const h = await harness({ backupRole: 'technician', backupMobile: '(512) 555-0111' });
    const session = await h.call(OWNER_PHONE, 'CA-owner');

    expect(session.ownerLineApprover).toEqual({ role: 'owner' });
    expect(session.actorUserId).toBe('clerk-owner');
    expect(await h.askDigest(session.id, 'CA-owner')).toContain(DIGEST_TEXT);
  });
});
