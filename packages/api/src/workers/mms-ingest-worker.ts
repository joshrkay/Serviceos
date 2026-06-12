/**
 * RV-050 / P0-009 — async MMS ingestion worker.
 *
 * Consumes the `mms_ingest` messages the webhook-side media seam enqueues
 * (src/sms/tech-status/mms-ingest.ts) and runs the FULL ingestion pipeline
 * off the webhook request: identity gate (registered tech phones only) →
 * active-job resolution → media fetch (Twilio Basic-auth) → files pipeline
 * store → AttachmentService attach. The logic is `ingestInboundMms`,
 * unchanged — only the execution context moved from the webhook request to
 * this worker, so webhook latency is back to milliseconds.
 *
 * Split decision (documented per P0-009): the ENTIRE pipeline — including
 * the identity/active-job check and the "clock in first" reply — runs here,
 * not inline in the webhook. The reply transport (`deps.sendReply`, backed
 * by MessageDelivery.sendSms in production) is the same async outbound SMS
 * dispatch seam the inline handler used; sending it from the worker keeps
 * the webhook free of even the identity-gate DB reads and keeps exactly one
 * code path for the whole flow. Duplicate suppression: Twilio webhook
 * retries collapse on the queue idempotency key (MessageSid), so the reply
 * and the attachments fire at most once per inbound MMS.
 *
 * Error semantics: ingestInboundMms isolates per-item fetch/store failures
 * internally (logged + skipped, never thrown). Anything that DOES throw
 * (identity-gate repo down, time-entry lookup failure) rethrows into the
 * queue's retry/DLQ semantics — transient DB blips retry instead of
 * silently dropping a tech's photos.
 */
import type { WorkerHandler, QueueMessage } from '../queues/queue';
import type { Logger } from '../logging/logger';
import {
  ingestInboundMms,
  MMS_INGEST_QUEUE_TYPE,
  type MmsIngestDeps,
  type MmsIngestQueuePayload,
} from '../sms/tech-status/mms-ingest';

export function createMmsIngestWorker(
  deps: MmsIngestDeps,
): WorkerHandler<MmsIngestQueuePayload> {
  return {
    type: MMS_INGEST_QUEUE_TYPE,
    async handle(message: QueueMessage<MmsIngestQueuePayload>, logger: Logger): Promise<void> {
      const { tenantId, fromPhone, messageSid, mediaItems } = message.payload ?? {};
      if (
        typeof tenantId !== 'string' ||
        typeof fromPhone !== 'string' ||
        typeof messageSid !== 'string' ||
        !Array.isArray(mediaItems)
      ) {
        // Permanent: a malformed payload never becomes valid on retry.
        logger.error('mms_ingest: malformed payload — dropping', {
          messageId: message.id,
        });
        return;
      }

      const result = await ingestInboundMms(
        {
          tenantId,
          fromE164: fromPhone,
          body: '',
          messageSid,
          media: mediaItems,
        },
        { ...deps, logger: deps.logger ?? logger },
      );

      logger.info('mms_ingest: processed inbound MMS', {
        tenantId,
        messageSid,
        outcome: result.outcome,
        stored: result.stored,
        skipped: result.skipped,
      });
    },
  };
}
