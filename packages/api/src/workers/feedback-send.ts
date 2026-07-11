import { Logger } from '../logging/logger';
import { QueueMessage, WorkerHandler } from '../queues/queue';
import { CustomerRepository } from '../customers/customer';
import { JobRepository } from '../jobs/job';
import { SettingsRepository } from '../settings/settings';
import { createFeedbackRequest, FeedbackRequestRepository } from '../feedback/feedback-request';
import { FeedbackDispatcher } from '../feedback/dispatcher';
import { SmsSuppressedError, SmsGateDecision } from '../notifications/gated-message-delivery';
import { SmsMessage } from '../notifications/delivery-provider';
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
  /**
   * Pure consent+DNC precheck — the SAME `evaluateCustomerSms` logic the gate
   * runs at send time (single source). Used to decide suppression BEFORE
   * minting the request row: a suppressed send must NOT leave a row behind, or
   * the next sweep's `findByJob` dedup would treat it as sent and skip forever,
   * even after the customer later grants consent or leaves the DNC list.
   */
  evaluateSms: (message: SmsMessage) => Promise<SmsGateDecision>;
  publicBaseUrl: string;
}): WorkerHandler<FeedbackSendPayload> {
  const { jobRepo, customerRepo, settingsRepo, feedbackRequestRepo, dispatcher, evaluateSms, publicBaseUrl } = deps;

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
      // wrapper the dispatcher sends through. Because the SMS body needs the
      // request token, we would normally have to mint the row before we can
      // send — but a minted row is poison if the send is then suppressed: the
      // next sweep's findByJob dedup skips forever, even after the customer
      // grants consent. So evaluate suppression FIRST (same gate logic, pure,
      // no token needed) and only mint when the send would actually go out.
      const consent = { smsConsent: customer.smsConsent === true, customerId: customer.id };
      const decision = await evaluateSms({
        to: customer.primaryPhone,
        body: '', // body is irrelevant to the consent/DNC decision
        tenantId,
        recipientClass: 'customer',
        consent,
      });
      if (decision.outcome === 'suppress') {
        logger.info('Feedback request suppressed by consent/DNC gate; no request row minted', {
          tenantId,
          jobId,
          customerId: customer.id,
          reason: decision.reason,
        });
        return;
      }

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
        await dispatcher.send({ to: customer.primaryPhone, body: text, tenantId, consent });
      } catch (err) {
        if (err instanceof SmsSuppressedError) {
          // Defense-in-depth for a consent/DNC change racing between the
          // precheck above and this send. The row is left behind here (rare),
          // but the common suppression cases never mint one.
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
