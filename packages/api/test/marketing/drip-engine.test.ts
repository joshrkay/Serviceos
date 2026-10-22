import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { createDripEngine, type DripEngineDeps } from '../../src/marketing/drip/drip-engine';
import { InMemoryDripRepository, type DripSignals } from '../../src/marketing/drip/drip-repository';
import type { DripSequence, DripStep } from '../../src/marketing/drip/sequence';
import type { Customer } from '../../src/customers/customer';

const TENANT = '11111111-1111-4111-8111-111111111111';
const CUSTOMER = '22222222-2222-4222-8222-222222222222';
const SEQ = '33333333-3333-4333-8333-333333333333';
const NOW = new Date('2026-10-22T17:00:00Z');

function makeCustomer(over: Partial<Customer> = {}): Customer {
  return {
    id: CUSTOMER,
    tenantId: TENANT,
    firstName: 'Pat',
    lastName: 'Q',
    displayName: 'Pat Q',
    primaryPhone: '(555) 123-4567',
    email: 'pat@example.com',
    preferredChannel: 'sms',
    smsConsent: true,
    isArchived: false,
    createdBy: 'u',
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  } as Customer;
}

function makeSequence(steps: DripStep[], status: 'active' | 'paused' = 'active'): DripSequence {
  return {
    id: SEQ,
    tenantId: TENANT,
    name: 'Win back',
    targetKind: 'lapsed_customers',
    targetDays: 180,
    steps,
    status,
    createdBy: 'owner',
    createdAt: NOW,
    updatedAt: NOW,
  };
}

interface Harness {
  deps: DripEngineDeps;
  repo: InMemoryDripRepository;
  audit: InMemoryAuditRepository;
  sendText: ReturnType<typeof vi.fn>;
  sendEmail: ReturnType<typeof vi.fn>;
  placeCall: ReturnType<typeof vi.fn>;
  checkCallConsent: ReturnType<typeof vi.fn>;
  signals: { [K in keyof DripSignals]: ReturnType<typeof vi.fn> };
  customer: { current: Customer | null };
  now: { current: Date };
}

async function setup(steps: DripStep[], overrides: Partial<DripEngineDeps> = {}): Promise<Harness> {
  const repo = new InMemoryDripRepository();
  const audit = new InMemoryAuditRepository();
  await repo.createSequence(makeSequence(steps));
  await repo.enroll(TENANT, SEQ, [{ customerId: CUSTOMER, sourceEntityType: null, sourceEntityId: null }], new Date(NOW.getTime() - 1000));
  const enrollment = [...repo.enrollments.values()][0];
  enrollment.enrolledAt = new Date(NOW.getTime() - 3_600_000);
  const sendText = vi.fn(async () => ({ status: 'sent' as const }));
  const sendEmail = vi.fn(async () => undefined);
  const placeCall = vi.fn(async () => ({ callSid: 'CA1' }));
  const checkCallConsent = vi.fn(async () => ({ allowed: true }));
  const signals = {
    findTargets: vi.fn(async () => []),
    findBookingSince: vi.fn(async () => null),
    hasRepliedSince: vi.fn(async () => false),
  };
  const customer = { current: makeCustomer() as Customer | null };
  const now = { current: NOW };
  const deps: DripEngineDeps = {
    repo,
    signals,
    customerRepo: { findById: async () => customer.current },
    messaging: { sendText },
    sendEmail,
    placeCall,
    checkCallConsent,
    isSmsRegistered: async () => true,
    quietHours: async () => ({ isAllowedNow: true, nextAllowedAt: NOW }),
    isOptedOut: async () => false,
    normalizePhone: (p) => `+1${p.replace(/\D/g, '')}`,
    auditRepo: audit,
    logger: { info: vi.fn(), warn: vi.fn() },
    now: () => now.current,
    ...overrides,
  };
  return { deps, repo, audit, sendText, sendEmail, placeCall, checkCallConsent, signals, customer, now };
}

const sms: DripStep = { channel: 'sms', delayMinutes: 0, body: 'Hi {{firstName}}' };
const email: DripStep = { channel: 'email', delayMinutes: 60, subject: 'Hello', body: 'Body' };
const call: DripStep = { channel: 'call', delayMinutes: 60, agentPhone: '+15559990000' };

const enrollmentOf = (h: Harness) => [...h.repo.enrollments.values()][0];
const auditTypes = async (h: Harness) => (await h.audit.findRecentByTenant(TENANT, { limit: 500 })).map((e) => e.eventType);

describe('drip engine — SMS step', () => {
  it('sends a marketing text through outbound messaging with a per-step dedupe key and advances', async () => {
    const h = await setup([sms, email]);
    const engine = createDripEngine(h.deps);
    expect(await engine.runTenant(TENANT)).toBe(1);
    expect(h.sendText).toHaveBeenCalledTimes(1);
    const text = h.sendText.mock.calls[0][0];
    expect(text.purpose).toBe('marketing');
    expect(text.recipient).toEqual({ kind: 'customer', customerId: CUSTOMER });
    expect(text.body).toBe('Hi Pat');
    expect(text.dedupe).toEqual({ messageKind: 'drip_step', recordId: `${enrollmentOf(h).id}:0` });
    expect(enrollmentOf(h)).toMatchObject({ status: 'active', currentStep: 1 });
    expect(enrollmentOf(h).nextRunAt).toEqual(new Date(NOW.getTime() + 60 * 60_000));
    expect(await auditTypes(h)).toContain('drip.step_sent');
  });

  it('holds the step (no send) until A2P 10DLC is approved', async () => {
    const h = await setup([sms], { isSmsRegistered: async () => false });
    await createDripEngine(h.deps).runTenant(TENANT);
    expect(h.sendText).not.toHaveBeenCalled();
    expect(enrollmentOf(h)).toMatchObject({ status: 'active', currentStep: 0, stepAttempts: 1 });
  });

  it('records the step failed and moves on after the retry cap', async () => {
    const h = await setup([sms, email], { isSmsRegistered: async () => false });
    enrollmentOf(h).stepAttempts = 4;
    await createDripEngine(h.deps).runTenant(TENANT);
    expect(h.repo.stepEvents[0]).toMatchObject({ outcome: 'failed', reason: 'a2p_not_approved' });
    expect(enrollmentOf(h).currentStep).toBe(1);
  });

  it('reschedules to the window opening when the gate defers the text', async () => {
    const at = new Date(NOW.getTime() + 5 * 3_600_000);
    const h = await setup([sms]);
    h.sendText.mockResolvedValueOnce({ status: 'scheduled', at, reason: 'quiet_hours' });
    await createDripEngine(h.deps).runTenant(TENANT);
    expect(enrollmentOf(h)).toMatchObject({ status: 'active', currentStep: 0, nextRunAt: at });
    expect(h.repo.stepEvents).toHaveLength(0);
  });

  it('exits as opted_out on a permanent DNC block, but only skips the step for a missing consent', async () => {
    const dnc = await setup([sms, email]);
    dnc.sendText.mockResolvedValueOnce({ status: 'blocked', reason: 'dnc', permanent: true });
    await createDripEngine(dnc.deps).runTenant(TENANT);
    expect(enrollmentOf(dnc)).toMatchObject({ status: 'exited', exitReason: 'opted_out' });

    const noConsent = await setup([sms, email]);
    noConsent.sendText.mockResolvedValueOnce({ status: 'blocked', reason: 'no_consent', permanent: true });
    await createDripEngine(noConsent.deps).runTenant(TENANT);
    expect(enrollmentOf(noConsent)).toMatchObject({ status: 'active', currentStep: 1 });
    expect(noConsent.repo.stepEvents[0]).toMatchObject({ outcome: 'skipped', reason: 'no_consent' });
  });
});

describe('drip engine — call step', () => {
  it('runs the voice consent gate, then places the call through the existing call service', async () => {
    const h = await setup([call]);
    await createDripEngine(h.deps).runTenant(TENANT);
    expect(h.checkCallConsent).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT, phoneE164: '+15551234567' }));
    expect(h.placeCall).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, customerId: CUSTOMER, agentPhone: '+15559990000' }),
    );
    expect(enrollmentOf(h)).toMatchObject({ status: 'completed', exitReason: 'completed' });
  });

  it('never places a call when consent is refused', async () => {
    const h = await setup([call]);
    h.checkCallConsent.mockResolvedValueOnce({ allowed: false, reason: 'consent_not_granted' });
    await createDripEngine(h.deps).runTenant(TENANT);
    expect(h.placeCall).not.toHaveBeenCalled();
    expect(h.repo.stepEvents[0]).toMatchObject({ outcome: 'skipped', reason: 'consent_not_granted' });
  });

  it('exits as opted_out when the number is on the DNC list', async () => {
    const h = await setup([call, email]);
    h.checkCallConsent.mockResolvedValueOnce({ allowed: false, reason: 'dnc_listed' });
    await createDripEngine(h.deps).runTenant(TENANT);
    expect(h.placeCall).not.toHaveBeenCalled();
    expect(enrollmentOf(h)).toMatchObject({ status: 'exited', exitReason: 'opted_out' });
  });

  it('retries (does not skip) when the call service fails', async () => {
    const h = await setup([call]);
    h.placeCall.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'provider_failed' }));
    await createDripEngine(h.deps).runTenant(TENANT);
    expect(enrollmentOf(h)).toMatchObject({ status: 'active', currentStep: 0, stepAttempts: 1 });
  });
});

describe('drip engine — email step', () => {
  it('sends with an idempotency key and an opt-out line', async () => {
    const h = await setup([{ ...email, delayMinutes: 0 }]);
    await createDripEngine(h.deps).runTenant(TENANT);
    const msg = h.sendEmail.mock.calls[0][0];
    expect(msg.to).toBe('pat@example.com');
    expect(msg.idempotencyKey).toBe(`drip_step:${enrollmentOf(h).id}:0`);
    expect(msg.text).toContain('reply to this email');
  });

  it('skips a customer with no email', async () => {
    const h = await setup([{ ...email, delayMinutes: 0 }]);
    h.customer.current = makeCustomer({ email: undefined });
    await createDripEngine(h.deps).runTenant(TENANT);
    expect(h.sendEmail).not.toHaveBeenCalled();
    expect(h.repo.stepEvents[0]).toMatchObject({ outcome: 'skipped', reason: 'no_email' });
  });
});

describe('drip engine — exit conditions and quiet hours', () => {
  it('exits as booked, credits the booking to the campaign, and sends nothing', async () => {
    const h = await setup([sms]);
    h.signals.findBookingSince.mockResolvedValueOnce({ appointmentId: 'appt-1', bookedAt: NOW });
    await createDripEngine(h.deps).runTenant(TENANT);
    expect(h.sendText).not.toHaveBeenCalled();
    expect(enrollmentOf(h)).toMatchObject({ status: 'exited', exitReason: 'booked', bookedAppointmentId: 'appt-1' });
    expect(await auditTypes(h)).toEqual(expect.arrayContaining(['drip.booking_attributed', 'drip.enrollment_exited']));
  });

  it('exits as replied', async () => {
    const h = await setup([sms]);
    h.signals.hasRepliedSince.mockResolvedValueOnce(true);
    await createDripEngine(h.deps).runTenant(TENANT);
    expect(h.sendText).not.toHaveBeenCalled();
    expect(enrollmentOf(h)).toMatchObject({ exitReason: 'replied' });
  });

  it('exits as opted_out when the number is opted out, before any step', async () => {
    const h = await setup([sms], { isOptedOut: async () => true });
    await createDripEngine(h.deps).runTenant(TENANT);
    expect(h.sendText).not.toHaveBeenCalled();
    expect(enrollmentOf(h)).toMatchObject({ exitReason: 'opted_out' });
  });

  it('exits when the customer is archived or gone', async () => {
    const h = await setup([sms]);
    h.customer.current = null;
    await createDripEngine(h.deps).runTenant(TENANT);
    expect(enrollmentOf(h)).toMatchObject({ exitReason: 'customer_unavailable' });
  });

  it('does nothing and reschedules when outside quiet hours, for every channel', async () => {
    const opens = new Date(NOW.getTime() + 14 * 3_600_000);
    for (const step of [sms, call, { ...email, delayMinutes: 0 }]) {
      const h = await setup([step], { quietHours: async () => ({ isAllowedNow: false, nextAllowedAt: opens }) });
      await createDripEngine(h.deps).runTenant(TENANT);
      expect(h.sendText).not.toHaveBeenCalled();
      expect(h.placeCall).not.toHaveBeenCalled();
      expect(h.checkCallConsent).not.toHaveBeenCalled();
      expect(h.sendEmail).not.toHaveBeenCalled();
      expect(enrollmentOf(h)).toMatchObject({ status: 'active', currentStep: 0, nextRunAt: opens });
    }
  });

  it('does not touch enrollments of a paused sequence', async () => {
    const h = await setup([sms]);
    await h.repo.setSequenceStatus(TENANT, SEQ, 'paused');
    expect(await createDripEngine(h.deps).runTenant(TENANT)).toBe(0);
    expect(h.sendText).not.toHaveBeenCalled();
  });

  it('a second sweep cannot run a step another worker already leased', async () => {
    const h = await setup([sms, email]);
    const engine = createDripEngine(h.deps);
    await Promise.all([engine.runTenant(TENANT), engine.runTenant(TENANT)]);
    expect(h.sendText).toHaveBeenCalledTimes(1);
  });
});

describe('drip engine — attribution after the sequence', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await setup([sms]);
  });

  it('credits a booking made after the sequence completed, within the window', async () => {
    const engine = createDripEngine(h.deps);
    await engine.runTenant(TENANT); // completes
    expect(enrollmentOf(h).bookedAt).toBeNull();
    h.signals.findBookingSince.mockResolvedValue({ appointmentId: 'appt-9', bookedAt: NOW });
    await engine.runTenant(TENANT);
    expect(enrollmentOf(h)).toMatchObject({ status: 'completed', bookedAppointmentId: 'appt-9' });
  });
});

describe('drip engine — enrollment', () => {
  it('enrolls targets once per customer and audits it', async () => {
    const h = await setup([sms]);
    h.repo.enrollments.clear();
    h.signals.findTargets.mockResolvedValue([
      { customerId: CUSTOMER, sourceEntityType: null, sourceEntityId: null },
    ]);
    const engine = createDripEngine(h.deps);
    expect(await engine.enrollTargets(TENANT, SEQ, { userId: 'owner', role: 'owner' })).toBe(1);
    expect(await engine.enrollTargets(TENANT, SEQ, { userId: 'owner', role: 'owner' })).toBe(0);
    expect(await auditTypes(h)).toContain('drip.targets_enrolled');
  });
});
