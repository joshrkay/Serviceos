import { Logger } from '../logging/logger';
import { Queue, QueueMessage, WorkerHandler } from '../queues/queue';
import { CustomerRepository } from '../customers/customer';
import { JobRepository } from '../jobs/job';
import { SettingsRepository } from '../settings/settings';
import { createFeedbackRequest, FeedbackRequestRepository } from '../feedback/feedback-request';
import { FeedbackDispatcher } from '../feedback/dispatcher';
import { SmsDeferredError, SmsSuppressedError } from '../notifications/gated-message-delivery';
import { resolveCustomerLanguage } from '../i18n/resolve-language';
import { tn } from '../notifications/i18n';

export interface FeedbackSendPayload {
  tenantId: string;
  jobId: string;
  /**
   * Set only on the delayed resume this worker enqueues after a quiet-hours
   * deferral: the request row minted by the deferred attempt, whose link this
   * attempt sends (instead of skipping it as an already-handled job).
   */
  resumeRequestId?: string;
}

export function createFeedbackSendWorker(deps: {
  jobRepo: JobRepository;
  customerRepo: CustomerRepository;
  settingsRepo: SettingsRepository;
  feedbackRequestRepo: FeedbackRequestRepository;
  dispatcher: FeedbackDispatcher;
  publicBaseUrl: string;
  /** Re-schedules a quiet-hours deferral as a delayed `feedback_send`. */
  queue: Pick<Queue, 'send'>;
  /** Clock seam for the resume delay; defaults to `new Date()`. */
  now?: () => Date;
}): WorkerHandler<FeedbackSendPayload> {
  const { jobRepo, customerRepo, settingsRepo, feedbackRequestRepo, dispatcher, publicBaseUrl } = deps;
  const now = deps.now ?? (() => new Date());

  return {
    type: 'feedback_send',
    async handle(message: QueueMessage<FeedbackSendPayload>, logger: Logger): Promise<void> {
      const { tenantId, jobId, resumeRequestId } = message.payload;

      const existing = await feedbackRequestRepo.findByJob(tenantId, jobId);
      // A resume after a quiet-hours deferral re-uses the row its deferred
      // attempt minted; any other existing row means the job was handled.
      const resumed =
        existing && existing.id === resumeRequestId && existing.status === 'pending' ? existing : null;
      if (existing && !resumed) {
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
      const saved = resumed ?? (await feedbackRequestRepo.create(createFeedbackRequest({ tenantId, jobId })));
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
          // A review request is non-transactional: it waits for the
          // recipient's daytime window.
          quietHours: 'defer',
        });
      } catch (err) {
        if (err instanceof SmsDeferredError) {
          // Not sent yet. The minted row would make a plain retry skip this
          // job, so schedule a resume that carries it. A fresh idempotency key:
          // this message's own key is held until it completes. If this enqueue
          // fails the error propagates and the queue retries — which then skips
          // on the kept row, so log it loudly.
          const delaySeconds = Math.max(1, Math.ceil((err.nextAllowedAt.getTime() - now().getTime()) / 1000));
          try {
            await deps.queue.send<FeedbackSendPayload>(
              'feedback_send',
              { tenantId, jobId, resumeRequestId: saved.id },
              `${tenantId}:${jobId}:feedback_send:resume:${err.nextAllowedAt.getTime()}`,
              { delaySeconds },
            );
          } catch (enqueueErr) {
            logger.error('Feedback request deferred but its resume could not be scheduled', {
              tenantId,
              jobId,
              requestId: saved.id,
              error: enqueueErr instanceof Error ? enqueueErr.message : String(enqueueErr),
            });
            throw enqueueErr;
          }
          logger.info('Feedback request deferred to the recipient send window', {
            tenantId,
            jobId,
            requestId: saved.id,
            nextAllowedAt: err.nextAllowedAt.toISOString(),
          });
          return;
        }
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
