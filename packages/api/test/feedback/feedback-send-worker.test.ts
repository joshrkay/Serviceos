/**
 * Unit tests for the feedback_send worker. WS1: the SMS consent + DNC gate is
 * now enforced centrally by the GatedMessageDelivery wrapper the dispatcher
 * sends through — NOT inline in the worker. The review-request link is
 * delivered only over SMS, so a suppressed number receives nothing; the worker
 * mints the request row first (needed for the link token) and treats a gate
 * suppression as a terminal skip.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { createFeedbackSendWorker, FeedbackSendPayload } from '../../src/workers/feedback-send';
import { InMemoryCustomerRepository, Customer } from '../../src/customers/customer';
import { InMemoryJobRepository } from '../../src/jobs/job';
import { InMemorySettingsRepository } from '../../src/settings/settings';
import { InMemoryFeedbackRequestRepository } from '../../src/feedback/feedback-request';
import {
  FeedbackDispatcher,
  FeedbackDispatchInput,
  MessageDeliveryFeedbackDispatcher,
} from '../../src/feedback/dispatcher';
import { InMemoryDeliveryProvider } from '../../src/notifications/delivery-provider';
import { GatedMessageDelivery } from '../../src/notifications/gated-message-delivery';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemoryDncRepository, normalizePhone } from '../../src/compliance/dnc';
import { createLogger } from '../../src/logging/logger';
import { QueueMessage } from '../../src/queues/queue';
import { createRecipientLocaleResolver } from '../../src/notifications/recipient-locale';
import { InMemoryLocationRepository } from '../../src/locations/location';

const TENANT = uuidv4();
const logger = createLogger({ service: 'test', environment: 'test', level: 'error' });

/**
 * Wraps the real MessageDeliveryFeedbackDispatcher (over a gated in-memory
 * provider) and records only sends that actually left the building — a gate
 * suppression throws and is NOT recorded.
 */
class GatingRecordingDispatcher implements FeedbackDispatcher {
  public sent: FeedbackDispatchInput[] = [];
  constructor(private readonly inner: FeedbackDispatcher) {}
  async send(input: FeedbackDispatchInput): Promise<void> {
    await this.inner.send(input);
    this.sent.push(input);
  }
}

function message(payload: FeedbackSendPayload): QueueMessage<FeedbackSendPayload> {
  return {
    id: uuidv4(),
    type: 'feedback_send',
    payload,
    attempts: 1,
    maxAttempts: 3,
    idempotencyKey: `feedback:${payload.jobId}`,
    createdAt: new Date().toISOString(),
  };
}

async function setup(
  customerOverrides: Partial<Customer> = {},
  opts: { now?: () => Date; reviewToggle?: boolean } = {},
) {
  const customerRepo = new InMemoryCustomerRepository();
  const customerId = uuidv4();
  await customerRepo.create({
    id: customerId,
    tenantId: TENANT,
    firstName: 'Sam',
    lastName: 'Lee',
    displayName: 'Sam Lee',
    primaryPhone: '+15559876543',
    preferredChannel: 'sms',
    smsConsent: true,
    isArchived: false,
    createdBy: 'u1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...customerOverrides,
  });

  const jobRepo = new InMemoryJobRepository();
  const jobId = uuidv4();
  await jobRepo.create({
    id: jobId,
    tenantId: TENANT,
    customerId,
    locationId: uuidv4(),
    jobNumber: 'JOB-1',
    summary: 'Repair',
    status: 'completed',
    priority: 'normal',
    createdBy: 'u1',
    // The review sweep stamps the job when it enqueues feedback_send.
    reviewRequestSentAt: new Date('2026-10-13T12:00:00Z'),
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const settingsRepo = new InMemorySettingsRepository();
  await settingsRepo.create({
    id: uuidv4(),
    tenantId: TENANT,
    businessName: 'Acme Plumbing',
    timezone: 'UTC',
    estimatePrefix: 'E-',
    invoicePrefix: 'I-',
    nextEstimateNumber: 1,
    nextInvoiceNumber: 1,
    defaultPaymentTermDays: 30,
    ...(opts.reviewToggle === undefined ? {} : { sendReviewRequest: opts.reviewToggle }),
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const feedbackRequestRepo = new InMemoryFeedbackRequestRepository();
  const dncRepo = new InMemoryDncRepository();
  const rawProvider = new InMemoryDeliveryProvider();
  const gated = new GatedMessageDelivery({
    base: rawProvider,
    dnc: dncRepo,
    auditRepo: new InMemoryAuditRepository(),
    enforcement: 'block',
    ...(opts.now
      ? {
          quietHours: {
            resolveRecipientLocale: createRecipientLocaleResolver({
              settingsRepo,
              locationRepo: new InMemoryLocationRepository(),
            }),
            now: opts.now,
          },
          logger: { info: () => undefined },
        }
      : {}),
  });
  const dispatcher = new GatingRecordingDispatcher(
    new MessageDeliveryFeedbackDispatcher(gated),
  );

  const worker = createFeedbackSendWorker({
    jobRepo,
    customerRepo,
    settingsRepo,
    feedbackRequestRepo,
    dispatcher,
    publicBaseUrl: 'https://app.example.com/',
    sendWindow: gated,
  });

  return { worker, jobId, customerId, jobRepo, feedbackRequestRepo, dispatcher, dncRepo, rawProvider };
}

describe('feedback_send worker — happy path', () => {
  it('sends the SMS and persists a request when consent is present and not on DNC', async () => {
    const { worker, jobId, feedbackRequestRepo, dispatcher } = await setup();
    await worker.handle(message({ tenantId: TENANT, jobId }), logger);

    expect(dispatcher.sent).toHaveLength(1);
    expect(dispatcher.sent[0].to).toBe('+15559876543');
    expect(dispatcher.sent[0].body).toContain('Acme Plumbing');

    const saved = await feedbackRequestRepo.findByJob(TENANT, jobId);
    expect(saved).not.toBeNull();
    // URL shape pins two things: no double slash from the trailing slash in
    // publicBaseUrl, and the SPA page path /feedback/:token — NOT the API
    // endpoint /public/feedback/:token, which would text customers raw JSON.
    expect(dispatcher.sent[0].body).toContain(`https://app.example.com/feedback/${saved!.token}`);
    expect(dispatcher.sent[0].body).not.toContain('/public/feedback/');
  });
});

describe('feedback_send worker — central consent + DNC gate', () => {
  // WS1 — the gate is now enforced by the delivery wrapper. The worker mints
  // the request row (the SMS body needs its token) then sends; a suppressed
  // send throws and is caught as a terminal skip. So: nothing leaves the
  // building, and the minted request row is left behind (harmless dangling
  // token, never texted).
  it('does not send when smsConsent is false (request still minted)', async () => {
    const { worker, jobId, feedbackRequestRepo, dispatcher, rawProvider } =
      await setup({ smsConsent: false });
    await worker.handle(message({ tenantId: TENANT, jobId }), logger);

    expect(dispatcher.sent).toHaveLength(0);
    expect(rawProvider.sentSms).toHaveLength(0);
    expect(await feedbackRequestRepo.findByJob(TENANT, jobId)).not.toBeNull();
  });

  it('does not send when the phone is on the DNC list (request still minted)', async () => {
    const { worker, jobId, feedbackRequestRepo, dispatcher, dncRepo, rawProvider } =
      await setup();
    await dncRepo.addToDnc(TENANT, normalizePhone('+15559876543'), 'test');

    await worker.handle(message({ tenantId: TENANT, jobId }), logger);

    expect(dispatcher.sent).toHaveLength(0);
    expect(rawProvider.sentSms).toHaveLength(0);
    expect(await feedbackRequestRepo.findByJob(TENANT, jobId)).not.toBeNull();
  });
});

describe('feedback_send worker — early returns', () => {
  it('skips when a feedback request already exists for the job (idempotent)', async () => {
    const { worker, jobId, feedbackRequestRepo, dispatcher } = await setup();
    // First run mints + sends.
    await worker.handle(message({ tenantId: TENANT, jobId }), logger);
    expect(dispatcher.sent).toHaveLength(1);

    // Second run must short-circuit on the existing request.
    await worker.handle(message({ tenantId: TENANT, jobId }), logger);
    expect(dispatcher.sent).toHaveLength(1);
    expect(await feedbackRequestRepo.findByJob(TENANT, jobId)).not.toBeNull();
  });

  it('skips when the customer has no primary phone', async () => {
    const { worker, jobId, dispatcher, feedbackRequestRepo } = await setup({ primaryPhone: undefined });
    await worker.handle(message({ tenantId: TENANT, jobId }), logger);
    expect(dispatcher.sent).toHaveLength(0);
    expect(await feedbackRequestRepo.findByJob(TENANT, jobId)).toBeNull();
  });

  it('skips when the job does not exist', async () => {
    const { worker, dispatcher } = await setup();
    await worker.handle(message({ tenantId: TENANT, jobId: uuidv4() }), logger);
    expect(dispatcher.sent).toHaveLength(0);
  });
});

describe('feedback_send worker — recipient quiet hours (a review request is non-transactional)', () => {
  // Tenant zone 'UTC' (setup). The 555 number cannot be placed and there is no
  // service location, so the window needs every US zone open with the 20:00
  // close: 19:00Z (15:00 ET … 09:00 HST) is open, 22:30Z is not.
  const LATE = new Date('2026-10-13T22:30:00Z');
  const MORNING = new Date('2026-10-14T19:00:00Z');

  it('defers by handing the job back to the review sweep: nothing minted, nothing texted, the stamp cleared', async () => {
    const { worker, jobId, jobRepo, feedbackRequestRepo, rawProvider } = await setup({}, { now: () => LATE });

    await worker.handle(message({ tenantId: TENANT, jobId }), logger);

    expect(rawProvider.sentSms).toHaveLength(0);
    expect(await feedbackRequestRepo.findByJob(TENANT, jobId)).toBeNull();
    // Unstamped = eligible again: the sweep re-enqueues it on an in-window tick.
    expect((await jobRepo.findById(TENANT, jobId))?.reviewRequestSentAt).toBeFalsy();
  });

  it('the in-window message the sweep re-enqueues sends once — and a duplicate delivery does not send again', async () => {
    let clock = LATE;
    const { worker, jobId, rawProvider, feedbackRequestRepo } = await setup({}, { now: () => clock });
    await worker.handle(message({ tenantId: TENANT, jobId }), logger); // deferred, handed back

    clock = MORNING;
    await worker.handle(message({ tenantId: TENANT, jobId }), logger);
    await worker.handle(message({ tenantId: TENANT, jobId }), logger); // redelivered

    expect(rawProvider.sentSms).toHaveLength(1);
    const saved = await feedbackRequestRepo.findByJob(TENANT, jobId);
    expect(rawProvider.sentSms[0].body).toContain(`/feedback/${saved!.token}`);
  });

  it('does not send a review request the owner switched off after it was queued', async () => {
    const { worker, jobId, rawProvider, feedbackRequestRepo } = await setup(
      {},
      { now: () => MORNING, reviewToggle: false },
    );

    await worker.handle(message({ tenantId: TENANT, jobId }), logger);

    expect(rawProvider.sentSms).toHaveLength(0);
    expect(await feedbackRequestRepo.findByJob(TENANT, jobId)).toBeNull();
  });

  it('a failed hand-back is safe to retry: nothing was minted, so the retry defers it again', async () => {
    const { worker, jobId, jobRepo, feedbackRequestRepo, rawProvider } = await setup({}, { now: () => LATE });
    const update = jobRepo.update.bind(jobRepo);
    let failNext = true;
    jobRepo.update = async (...args: Parameters<typeof jobRepo.update>) => {
      if (failNext) {
        failNext = false;
        throw new Error('db blip');
      }
      return update(...args);
    };

    await expect(worker.handle(message({ tenantId: TENANT, jobId }), logger)).rejects.toThrow('db blip');
    expect(await feedbackRequestRepo.findByJob(TENANT, jobId)).toBeNull();

    await worker.handle(message({ tenantId: TENANT, jobId }), logger); // the queue's retry

    expect(rawProvider.sentSms).toHaveLength(0);
    expect((await jobRepo.findById(TENANT, jobId))?.reviewRequestSentAt).toBeFalsy();
  });
});
