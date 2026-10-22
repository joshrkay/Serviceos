import { Logger } from '../logging/logger';
import { QueueMessage, WorkerHandler } from '../queues/queue';
import { CustomerRepository } from '../customers/customer';
import { JobRepository } from '../jobs/job';
import { SettingsRepository } from '../settings/settings';
import { createFeedbackRequest, FeedbackRequestRepository } from '../feedback/feedback-request';
import { FeedbackDispatcher } from '../feedback/dispatcher';
import { SmsSuppressedError, type GatedMessageDelivery } from '../notifications/gated-message-delivery';
import { resolveCustomerLanguage } from '../i18n/resolve-language';
import { tn } from '../notifications/i18n';

export interface FeedbackSendPayload {
  tenantId: string;
  jobId: string;
}

/**
 * The review request is non-transactional, so it honours the recipient's
 * quiet hours — but its deferral must not create anything a retry would trip
 * over. So the window is asked FIRST (`sendWindow`, the gate's own verdict):
 * closed → the job is handed back to the review sweep (its
 * review_request_sent_at cleared) and nothing is minted or queued; the sweep,
 * which re-checks the toggle and the recency floor every tick, re-enqueues it
 * in-window. Open → mint the link row and send at once, at most once per job
 * as before. No delayed job, no resume key, no second send.
 */
export function createFeedbackSendWorker(deps: {
  jobRepo: JobRepository;
  customerRepo: CustomerRepository;
  settingsRepo: SettingsRepository;
  feedbackRequestRepo: FeedbackRequestRepository;
  dispatcher: FeedbackDispatcher;
  publicBaseUrl: string;
  /** The gate's send-window verdict (GatedMessageDelivery in production). */
  sendWindow: Pick<GatedMessageDelivery, 'sendWindowVerdict'>;
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

      const settings = await settingsRepo.findByTenant(tenantId);
      if (settings?.sendReviewRequest === false) {
        // Switched off after the sweep enqueued this.
        logger.info('Skipping feedback request: review requests are turned off', { tenantId, jobId });
        return;
      }

      const verdict = await deps.sendWindow.sendWindowVerdict({
        tenantId,
        customerId: customer.id,
        to: customer.primaryPhone,
      });
      if (!verdict.isAllowedNow) {
        // Not sent yet. Nothing has been minted, so this is safe to retry if
        // the write below fails; once it lands the sweep re-enqueues the job.
        await jobRepo.update(tenantId, jobId, { reviewRequestSentAt: undefined });
        logger.info('Feedback request deferred to the recipient send window; handed back to the sweep', {
          tenantId,
          jobId,
          nextAllowedAt: verdict.nextAllowedAt.toISOString(),
        });
        return;
      }

      // §7 / WS1 — consent + DNC are enforced centrally by the GatedMessageDelivery
      // wrapper the dispatcher sends through. This worker just forwards the
      // stored consent flag; a suppressed send throws SmsSuppressedError, caught
      // below as a terminal skip (not a retryable job failure).
      const saved = await feedbackRequestRepo.create(createFeedbackRequest({ tenantId, jobId }));
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
          // Untagged on purpose: the window was checked just above, before
          // the row was minted. A tagged send deferred here would strand it.
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
