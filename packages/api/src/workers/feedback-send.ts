import { Logger } from '../logging/logger';
import { QueueMessage, WorkerHandler } from '../queues/queue';
import { CustomerRepository } from '../customers/customer';
import { JobRepository } from '../jobs/job';
import { SettingsRepository } from '../settings/settings';
import { createFeedbackRequest, FeedbackRequestRepository } from '../feedback/feedback-request';
import { FeedbackDispatcher } from '../feedback/dispatcher';
import { DncRepository, normalizePhone } from '../compliance/dnc';

export interface FeedbackSendPayload {
  tenantId: string;
  jobId: string;
}

export function createFeedbackSendWorker(deps: {
  jobRepo: JobRepository;
  customerRepo: CustomerRepository;
  settingsRepo: SettingsRepository;
  feedbackRequestRepo: FeedbackRequestRepository;
  dispatcher: FeedbackDispatcher;
  dncRepo: DncRepository;
  publicBaseUrl: string;
}): WorkerHandler<FeedbackSendPayload> {
  const { jobRepo, customerRepo, settingsRepo, feedbackRequestRepo, dispatcher, dncRepo, publicBaseUrl } = deps;

  return {
    type: 'feedback_send',
    async handle(message: QueueMessage<FeedbackSendPayload>, logger: Logger): Promise<void> {
      const { tenantId, jobId } = message.payload;

      const existing = await feedbackRequestRepo.findByJob(tenantId, jobId);
      if (existing) {
        logger.info('Feedback request already exists for job; skipping', { tenantId, jobId, requestId: existing.id });
        return;
      }

      const job = await jobRepo.findById(tenantId, jobId);
      if (!job) {
        logger.warn('Cannot send feedback request: job not found', { tenantId, jobId });
        return;
      }

      const customer = await customerRepo.findById(tenantId, job.customerId);
      if (!customer?.primaryPhone) {
        logger.info('Skipping feedback request: customer has no primary phone', { tenantId, jobId, customerId: job.customerId });
        return;
      }

      // Consent + DNC gate (mirrors sendCustomerMessage). The feedback request
      // is delivered only over SMS, so without consent there is no channel to
      // send on — don't mint a request/token that can never be delivered.
      if (customer.smsConsent !== true) {
        logger.info('Skipping feedback request: customer has not consented to SMS', { tenantId, jobId, customerId: customer.id });
        return;
      }
      if (await dncRepo.isOnDnc(tenantId, normalizePhone(customer.primaryPhone))) {
        logger.info('Skipping feedback request: customer phone is on the DNC list', { tenantId, jobId, customerId: customer.id });
        return;
      }

      const request = createFeedbackRequest({ tenantId, jobId });
      const saved = await feedbackRequestRepo.create(request);
      const settings = await settingsRepo.findByTenant(tenantId);
      const businessName = settings?.businessName ?? 'our team';
      const normalizedBase = publicBaseUrl.replace(/\/$/, '');
      const url = `${normalizedBase}/public/feedback/${saved.token}`;
      const text = `Thanks for choosing ${businessName}. We'd love your feedback: ${url}`;

      await dispatcher.send({ to: customer.primaryPhone, body: text });

      logger.info('Feedback request sent', { tenantId, jobId, requestId: saved.id, customerId: customer.id });
    },
  };
}
