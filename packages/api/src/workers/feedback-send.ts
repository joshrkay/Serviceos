import { Logger } from '../logging/logger';
import { QueueMessage, WorkerHandler } from '../queues/queue';
import { CustomerRepository } from '../customers/customer';
import { JobRepository } from '../jobs/job';
import { SettingsRepository } from '../settings/settings';
import { createFeedbackRequest, FeedbackRequestRepository } from '../feedback/feedback-request';
import { FeedbackDispatcher } from '../feedback/dispatcher';
import { SmsSuppressedError } from '../notifications/gated-message-delivery';
import { resolveCustomerLanguage } from '../i18n/resolve-language';
import { tn } from '../notifications/i18n';

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
  publicBaseUrl: string;
}): WorkerHandler<FeedbackSendPayload> {
  const { jobRepo, customerRepo, settingsRepo, feedbackRequestRepo, dispatcher, publicBaseUrl } = deps;

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

      // §7 / WS1 — consent + DNC are enforced centrally by the GatedMessageDelivery
      // wrapper the dispatcher sends through. This worker just forwards the
      // stored consent flag; a suppressed send throws SmsSuppressedError, caught
      // below as a terminal skip (not a retryable job failure).
      const request = createFeedbackRequest({ tenantId, jobId });
      const saved = await feedbackRequestRepo.create(request);
      const settings = await settingsRepo.findByTenant(tenantId);
      const businessName = settings?.businessName ?? 'our team';
      const normalizedBase = publicBaseUrl.replace(/\/$/, '');
      // /feedback/:token is the SPA page; /public/feedback/:token is the API
      // JSON endpoint — texting the latter would show customers raw JSON.
      const url = `${normalizedBase}/feedback/${saved.token}`;
      const language = resolveCustomerLanguage({
        customerPreferredLanguage: customer.preferredLanguage,
        tenantDefaultLanguage: settings?.defaultLanguage,
      });
      const text = tn('sms.feedback.request', language, { business: businessName, url });

      try {
        await dispatcher.send({
          to: customer.primaryPhone,
          body: text,
          tenantId,
          consent: { smsConsent: customer.smsConsent === true, customerId: customer.id },
        });
      } catch (err) {
        if (err instanceof SmsSuppressedError) {
          logger.info('Feedback request send suppressed by consent/DNC gate', {
            tenantId,
            jobId,
            customerId: customer.id,
            reason: err.reason,
          });
          return;
        }
        throw err;
      }

      logger.info('Feedback request sent', { tenantId, jobId, requestId: saved.id, customerId: customer.id });
    },
  };
}
