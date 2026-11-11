/**
 * The booking-confirmation text against the customer-SMS consent gate in BLOCK
 * mode (the production mode), with consent captured on the call through the
 * same `recordSmsConsentFromVoice` seam the voice processor uses.
 *
 * Proves both halves of the on-call fix: without a recorded grant the
 * confirmation is suppressed by the gate (so the caller must not be promised
 * one), and after a recorded voice grant the very same confirmation passes.
 *
 * Value: protects=a caller who says yes to the on-call text question really receives the booking confirmation, and one who has not consented does not (so the promise line is honest);
 *   fails_when=the voice grant stops flipping the flag the gate reads, the gate stops reading it, or a DNC listing stops outranking a grant;
 *   why_new=no test covered a voice-captured grant reaching the confirmation send; consent-cross-channel covers revocation, not this path;
 *   seam=none (real CreateBookingExecutionHandler + TransactionalCommsService + GatedMessageDelivery over in-memory repos);
 *   no_claim=Twilio delivery, the integration-level consent ledger at Postgres
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { CreateBookingExecutionHandler } from '../../src/proposals/execution/create-booking-handler';
import { createAppointment } from '../../src/appointments/appointment';
import { InMemoryAppointmentRepository } from '../../src/appointments/in-memory-appointment';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemoryCustomerRepository, type Customer } from '../../src/customers/customer';
import { InMemoryJobRepository, type Job } from '../../src/jobs/job';
import { InMemorySettingsRepository } from '../../src/settings/settings';
import { InMemoryInvoiceRepository } from '../../src/invoices/invoice';
import { InMemoryDeliveryProvider } from '../../src/notifications/delivery-provider';
import { InMemoryDispatchRepository } from '../../src/notifications/dispatch-repository';
import { GatedMessageDelivery } from '../../src/notifications/gated-message-delivery';
import { TransactionalCommsService } from '../../src/notifications/transactional-comms-service';
import { InMemoryDncRepository, normalizePhone } from '../../src/compliance/dnc';
import { InMemoryConsentEventRepository } from '../../src/compliance/consent-events';
import { recordSmsConsentFromVoice } from '../../src/voice/outbound-consent';
import { createProposal } from '../../src/proposals/proposal';
import { createLogger } from '../../src/logging/logger';

const TENANT = '00000000-0000-4000-8000-0000000000b1';
const PHONE = '+15125550100';
const VOICE_SESSION_ID = 'voice-session-booking-consent';

describe('booking confirmation text vs the SMS consent gate (block mode), consent from the call', () => {
  let appointmentRepo: InMemoryAppointmentRepository;
  let auditRepo: InMemoryAuditRepository;
  let customerRepo: InMemoryCustomerRepository;
  let jobRepo: InMemoryJobRepository;
  let consentEventRepo: InMemoryConsentEventRepository;
  let dncRepo: InMemoryDncRepository;
  let delivery: InMemoryDeliveryProvider;
  let handler: CreateBookingExecutionHandler;
  let customer: Customer;
  let job: Job;

  beforeEach(async () => {
    appointmentRepo = new InMemoryAppointmentRepository();
    auditRepo = new InMemoryAuditRepository();
    customerRepo = new InMemoryCustomerRepository();
    jobRepo = new InMemoryJobRepository();
    consentEventRepo = new InMemoryConsentEventRepository();
    dncRepo = new InMemoryDncRepository();
    delivery = new InMemoryDeliveryProvider();
    const settingsRepo = new InMemorySettingsRepository();

    await settingsRepo.create({
      id: uuidv4(),
      tenantId: TENANT,
      businessName: 'Rivet HVAC',
      timezone: 'UTC',
      estimatePrefix: 'EST-',
      invoicePrefix: 'INV-',
      nextEstimateNumber: 1,
      nextInvoiceNumber: 1,
      defaultPaymentTermDays: 30,
      autoSendAppointmentReminders: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    customer = {
      id: uuidv4(),
      tenantId: TENANT,
      firstName: 'Dana',
      lastName: 'Lee',
      displayName: 'Dana Lee',
      primaryPhone: PHONE,
      preferredChannel: 'sms',
      smsConsent: false,
      isArchived: false,
      createdBy: 'owner-1',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await customerRepo.create(customer);
    job = {
      id: uuidv4(),
      tenantId: TENANT,
      customerId: customer.id,
      locationId: uuidv4(),
      jobNumber: 'JOB-901',
      summary: 'Furnace not heating',
      status: 'scheduled',
      priority: 'normal',
      moneyState: 'no_estimate',
      createdBy: 'owner-1',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await jobRepo.create(job);

    const gated = new GatedMessageDelivery({
      base: delivery,
      dnc: dncRepo,
      auditRepo,
      enforcement: 'block',
      consentLedger: consentEventRepo,
    });
    const comms = new TransactionalCommsService({
      delivery: gated,
      dispatchRepo: new InMemoryDispatchRepository(),
      dncRepo,
      appointmentRepo,
      jobRepo,
      customerRepo,
      settingsRepo,
      invoiceRepo: new InMemoryInvoiceRepository(),
      pool: null,
      logger: createLogger({ service: 'test', environment: 'test', level: 'error' }),
    });
    handler = new CreateBookingExecutionHandler(appointmentRepo, auditRepo, comms);
  });

  async function confirmOneHeldBooking(startIso: string) {
    const appt = await createAppointment(
      {
        tenantId: TENANT,
        jobId: job.id,
        scheduledStart: new Date(startIso),
        scheduledEnd: new Date(new Date(startIso).getTime() + 60 * 60 * 1000),
        timezone: 'UTC',
        createdBy: 'agent-1',
        holdPendingApproval: true,
        holdExpiryAt: new Date('2099-01-01T00:00:00Z'),
      },
      appointmentRepo,
    );
    const proposal = createProposal({
      tenantId: TENANT,
      proposalType: 'create_booking',
      payload: { appointmentId: appt.id },
      summary: 'Confirm held booking',
      createdBy: 'owner-1',
    });
    return handler.execute(proposal, { tenantId: TENANT, executedBy: 'owner-1' });
  }

  /** The gate's own audit rows (`sms.suppressed`), keyed by the customer it refused. */
  const suppressions = async () =>
    (await auditRepo.findByEntity(TENANT, 'sms_message', customer.id)).filter(
      (e) => e.eventType === 'sms.suppressed',
    );

  const grantOnCall = () =>
    recordSmsConsentFromVoice(
      { consentLedger: consentEventRepo, customerRepo, auditRepo },
      {
        tenantId: TENANT,
        customerId: customer.id,
        phone: PHONE,
        voiceSessionId: VOICE_SESSION_ID,
        actorId: 'calling-agent',
      },
    );

  it('without a recorded grant the confirmation is suppressed — the booking still confirms', async () => {
    const result = await confirmOneHeldBooking('2099-06-10T17:00:00Z');

    expect(result.success).toBe(true);
    expect(delivery.sentSms).toHaveLength(0);
    const suppressed = await suppressions();
    expect(suppressed).toHaveLength(1);
    expect(suppressed[0]!.metadata).toMatchObject({ reason: 'no_consent' });
  });

  it('after the consent recorded on the call, the booking confirmation text passes the gate', async () => {
    const grant = await grantOnCall();
    expect(grant.smsConsentChanged).toBe(true);
    expect(consentEventRepo.rows[0]).toMatchObject({
      kind: 'sms',
      state: 'granted',
      source: 'voice',
      voiceSessionId: VOICE_SESSION_ID,
    });

    const result = await confirmOneHeldBooking('2099-06-10T17:00:00Z');

    expect(result.success).toBe(true);
    expect(delivery.sentSms).toHaveLength(1);
    expect(normalizePhone(delivery.sentSms[0]!.to)).toBe(normalizePhone(PHONE));
    expect(delivery.sentSms[0]!.body).toMatch(/confirmed/i);
    expect(await suppressions()).toHaveLength(0);
  });

  it('a DNC listing still outranks a voice grant — the gate suppresses with reason dnc', async () => {
    await grantOnCall();
    dncRepo.add(TENANT, normalizePhone(PHONE));

    await confirmOneHeldBooking('2099-06-10T17:00:00Z');

    expect(delivery.sentSms).toHaveLength(0);
    const suppressed = await suppressions();
    expect(suppressed).toHaveLength(1);
    expect(suppressed[0]!.metadata).toMatchObject({ reason: 'dnc' });
  });
});
