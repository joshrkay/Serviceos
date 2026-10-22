/**
 * B3-1 — the owner line's read privileges are re-checked every turn.
 *
 * B1's follow-up re-checks WHO approves before every approval turn, but the
 * rest of the owner-line privilege was fixed at pick-up for the whole call:
 * the phone actor (`session.actorUserId`, the subject every owner lookup is
 * authorised by), `extendedIntents` and the FSM's `ownerSession` flag. A
 * backup supervisor deactivated or replaced mid-call kept hearing the owner's
 * day, digest and pending work until they hung up. Each turn now re-resolves
 * the line from the session's pinned caller-ID (`resolveOwnerLineApprover`,
 * the same resolver establishment uses); a line that no longer resolves is an
 * unrecognised caller for that turn, with the existing refusal copy.
 *
 * Handler level, end to end through the Gather adapter (and the media-streams
 * entry point), with mutable tenant settings and users rows. The member-role
 * resolver mirrors production's Postgres loader: an inactive member has no
 * role.
 */
import { describe, it, expect, vi } from 'vitest';
import { TwilioGatherAdapter } from '../../src/telephony/twilio-adapter';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import type { LLMGateway, LLMRequest, LLMResponse } from '../../src/ai/gateway/gateway';
import { InMemoryProposalRepository } from '../../src/proposals/proposal';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import type { SettingsRepository } from '../../src/settings/settings';
import type { User, UserRepository } from '../../src/users/user';
import { InMemoryAppointmentRepository } from '../../src/appointments/in-memory-appointment';
import type { Appointment } from '../../src/appointments/appointment';
import { InMemoryJobRepository, type Job } from '../../src/jobs/job';
import { InMemoryDailyDigestRepository } from '../../src/digest/digest-service';
import { InMemoryEstimateRepository, type Estimate } from '../../src/estimates/estimate';
import { InMemoryInvoiceRepository } from '../../src/invoices/invoice';
import { InMemoryDroppedCallRecoveryRepository } from '../../src/sms/recovery/scheduler';

const TENANT = 't-line-recheck';
const OWNER_PHONE = '+15125550100';
const BACKUP_MOBILE = '+15125550111';
const BACKUP_ID = 'user-backup-line';
const OWNER_REFUSAL = 'owner-level report';

// One utterance per lookup, mapped to the classification the stub model
// returns for it. Nonsense phrases so no deterministic pre-LLM matcher fires.
const ASK = {
  day: { speech: 'question one please', intentType: 'lookup_day_overview', answer: 'You have 1 appointment today' },
  digest: { speech: 'question two please', intentType: 'lookup_digest', answer: 'Owner digest: revenue was strong' },
  pending: { speech: 'question three please', intentType: 'lookup_pending_items', answer: '1 estimate is out waiting on a yes' },
} as const;
type AskKey = keyof typeof ASK;
// Every piece of tenant data a lookup above could speak.
const TENANT_DATA = ['1 appointment', 'Owner digest', 'revenue was strong', 'estimate is out', 'Main drain repair'];

function lookupGateway(): LLMGateway {
  return {
    complete: vi.fn(async (req: LLMRequest) => {
      const last = String(req.messages[req.messages.length - 1]?.content ?? '');
      const hit = Object.values(ASK).find((a) => last.includes(a.speech));
      const content = JSON.stringify(
        hit ? { intentType: hit.intentType, confidence: 0.96 } : { intentType: 'unknown', confidence: 0.2 },
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

function totals(totalCents: number) {
  return { subtotalCents: totalCents, discountCents: 0, taxRateBps: 0, taxableSubtotalCents: totalCents, taxCents: 0, totalCents };
}

async function harness() {
  const tenantSettings: { ownerPhone: string; backupSupervisorUserId: string; escalationSettings: object } = {
    ownerPhone: OWNER_PHONE,
    backupSupervisorUserId: BACKUP_ID,
    escalationSettings: {},
  };
  const settingsFailure = { next: false };
  const settingsRepo = {
    findByTenant: vi.fn(async () => {
      if (settingsFailure.next) throw new Error('settings read timed out');
      return { ...tenantSettings };
    }),
  } as unknown as SettingsRepository;

  const users: Array<Pick<User, 'id' | 'tenantId' | 'role' | 'status' | 'clerkUserId' | 'mobileNumber'>> = [
    { id: 'u-owner', tenantId: TENANT, role: 'owner', status: 'active', clerkUserId: 'clerk-owner' },
    { id: BACKUP_ID, tenantId: TENANT, role: 'dispatcher', status: 'active', clerkUserId: 'clerk-backup-line', mobileNumber: BACKUP_MOBILE },
  ];
  const backup = users[1]!;
  const userRepo = {
    findById: async (t: string, id: string) => users.find((u) => u.tenantId === t && u.id === id) ?? null,
    findByMobileNumber: async (t: string, e164: string) =>
      users.find((u) => u.tenantId === t && u.mobileNumber === e164) ?? null,
    findByTenant: async (t: string, filter?: { role?: string }) =>
      users.filter((u) => u.tenantId === t && (!filter?.role || u.role === filter.role)),
  } as unknown as UserRepository;

  const appointmentRepo = new InMemoryAppointmentRepository();
  const jobRepo = new InMemoryJobRepository();
  const proposalRepo = new InMemoryProposalRepository();
  const dailyDigestRepo = new InMemoryDailyDigestRepository();
  const estimateRepo = new InMemoryEstimateRepository();
  const invoiceRepo = new InMemoryInvoiceRepository();
  const droppedCallRecoveryRepo = new InMemoryDroppedCallRecoveryRepository();

  await jobRepo.create({
    id: 'job-line-1', tenantId: TENANT, customerId: 'cust-1', locationId: 'loc-1', jobNumber: 'JOB-1',
    summary: 'Main drain repair', status: 'scheduled', priority: 'normal', createdBy: 'u1',
    createdAt: new Date('2026-06-01T00:00:00.000Z'), updatedAt: new Date('2026-06-01T00:00:00.000Z'),
  } as Job);
  await appointmentRepo.create({
    id: 'appt-line-1', tenantId: TENANT, jobId: 'job-line-1', scheduledStart: new Date(),
    scheduledEnd: new Date(Date.now() + 60_000), status: 'scheduled', holdPendingApproval: false,
    createdBy: 'u1', createdAt: new Date(), updatedAt: new Date(),
  } as Appointment);
  await dailyDigestRepo.upsert(
    TENANT,
    new Date().toISOString().slice(0, 10),
    {} as Parameters<InMemoryDailyDigestRepository['upsert']>[2],
    'Owner digest: revenue was strong',
  );
  await estimateRepo.create({
    id: 'est-line-1', tenantId: TENANT, jobId: 'job-line-1', estimateNumber: 'EST-1', status: 'sent',
    lineItems: [], totals: totals(12300), sentAt: new Date(Date.now() - 86_400_000), version: 1,
    createdBy: 'u1', createdAt: new Date(), updatedAt: new Date(),
  } as Estimate);

  const store = new VoiceSessionStore({ startInterval: false });
  const adapter = new TwilioGatherAdapter({
    store,
    gateway: lookupGateway(),
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
        droppedCallRecoveryRepo,
        // Production's Postgres loader: a member who is not active has no role.
        resolveMemberRole: async (t: string, subject: string) => {
          const u = users.find((x) => x.tenantId === t && (x.clerkUserId === subject || x.id === subject));
          return u && u.status === 'active' ? u.role : null;
        },
      },
      shared: { appointmentRepo, jobRepo, proposalRepo },
    } as never,
  });

  async function call(from: string, callSid: string): Promise<string> {
    // #1223 — the owner line is only trusted when fully (A) attested.
    await adapter.handleInbound({ callSid, from, to: '+15125550000', tenantId: TENANT, stirVerstat: 'TN-Validation-Passed-A' });
    const session = store.findByCallSid(callSid)!;
    // Without a DB pool the caller lands in ask_caller; emulate the
    // identified-caller transition so handleGather classifies.
    session.machine.dispatch({ type: 'caller_known', customerId: 'cust-1' });
    return session.id;
  }
  const ask = (sessionId: string, callSid: string, key: AskKey) =>
    adapter.handleGather({ sessionId, callSid, speechResult: ASK[key].speech, confidence: 0.95, tenantId: TENANT });

  return { adapter, store, tenantSettings, settingsFailure, backup, dailyDigestRepo, call, ask };
}

function expectNoTenantData(xml: string) {
  for (const data of TENANT_DATA) expect(xml).not.toContain(data);
}

describe('B3-1 — a backup who loses the owner line mid-call loses its lookups that turn (Gather)', () => {
  const changes = [
    ['deactivated', (h: Awaited<ReturnType<typeof harness>>) => (h.backup.status = 'suspended')],
    ['replaced as backup', (h: Awaited<ReturnType<typeof harness>>) => (h.tenantSettings.backupSupervisorUserId = 'someone-else')],
    // The line now resolves, but to someone else: the owner phone. What the
    // backup was granted at pick-up is theirs, not the owner's.
    ['whose mobile became the owner phone', (h: Awaited<ReturnType<typeof harness>>) => (h.tenantSettings.ownerPhone = BACKUP_MOBILE)],
  ] as const;

  describe.each(changes)('a backup %s between turns', (label, change) => {
    it.each(['day', 'digest', 'pending'] as const)('is refused the %s lookup, and hears no tenant data', async (key) => {
      const h = await harness();
      const callSid = `CA-${label.replace(/\W+/g, '-')}-${key}`;
      const sessionId = await h.call(BACKUP_MOBILE, callSid);
      // While they are the backup, the line answers.
      expect(await h.ask(sessionId, callSid, 'day')).toContain(ASK.day.answer);

      change(h);
      const findLatest = vi.spyOn(h.dailyDigestRepo, 'findLatest');
      const xml = await h.ask(sessionId, callSid, key);

      expect(xml).toContain(OWNER_REFUSAL);
      expectNoTenantData(xml);
      expect(findLatest).not.toHaveBeenCalled();
      const session = h.store.get(sessionId)!;
      expect(session.machine.currentContext.ownerSession).not.toBe(true);
      expect(session.machine.currentContext.extendedIntents).not.toBe(true);
      expect(session.actorUserId).toBeUndefined();
    });
  });

  it('a still-valid backup keeps every lookup for the whole call', async () => {
    const h = await harness();
    const sessionId = await h.call(BACKUP_MOBILE, 'CA-valid-backup');
    for (const key of ['day', 'digest', 'pending', 'day'] as const) {
      expect(await h.ask(sessionId, 'CA-valid-backup', key)).toContain(ASK[key].answer);
    }
    expect(h.store.get(sessionId)!.actorUserId).toBe('clerk-backup-line');
  });

  it("the owner's own line is unaffected by a change to the backup", async () => {
    const h = await harness();
    const sessionId = await h.call(OWNER_PHONE, 'CA-owner-line');
    expect(await h.ask(sessionId, 'CA-owner-line', 'day')).toContain(ASK.day.answer);
    h.backup.status = 'suspended';
    h.tenantSettings.backupSupervisorUserId = 'someone-else';
    for (const key of ['digest', 'pending'] as const) {
      expect(await h.ask(sessionId, 'CA-owner-line', key)).toContain(ASK[key].answer);
    }
    expect(h.store.get(sessionId)!.actorUserId).toBe('clerk-owner');
  });

  it('a lookup failure drops the privileges for that turn only', async () => {
    const h = await harness();
    const sessionId = await h.call(BACKUP_MOBILE, 'CA-transient');

    h.settingsFailure.next = true;
    const refused = await h.ask(sessionId, 'CA-transient', 'digest');
    expect(refused).toContain(OWNER_REFUSAL);
    expectNoTenantData(refused);

    h.settingsFailure.next = false;
    expect(await h.ask(sessionId, 'CA-transient', 'digest')).toContain(ASK.digest.answer);
    const session = h.store.get(sessionId)!;
    expect(session.machine.currentContext.ownerSession).toBe(true);
    expect(session.machine.currentContext.extendedIntents).toBe(true);
    expect(session.actorUserId).toBe('clerk-backup-line');
  });
});

describe('B3-1 — the same re-check on the media-streams entry point', () => {
  it('a backup deactivated between finals is refused the day lookup', async () => {
    const h = await harness();
    const sessionId = await h.call(BACKUP_MOBILE, 'CA-stream-deactivated');
    const say = (speech: string) =>
      h.adapter.processCallerUtterance({ sessionId, callSid: 'CA-stream-deactivated', speechResult: speech, tenantId: TENANT });
    const spoken = (fx: Awaited<ReturnType<typeof say>>) =>
      fx.map((e) => (e.type === 'tts_play' ? String((e.payload as { text?: string }).text ?? '') : '')).join(' ');

    expect(spoken(await say(ASK.day.speech))).toContain(ASK.day.answer);
    h.backup.status = 'suspended';
    const line = spoken(await say(ASK.day.speech));

    expect(line).toContain(OWNER_REFUSAL);
    expectNoTenantData(line);
  });
});
