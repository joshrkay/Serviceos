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
 *
 * U2 — CUSTOMER path. The tech pipeline above returns `ignored_non_tech`
 * when the sender is not a registered technician. Rather than dropping
 * that MMS, the worker hands it to the optional `customerIntake` —
 * resolve/create the customer → catalog-grounded draft_estimate proposal
 * (owner-approval queue, never auto-issued). The dep is OPTIONAL: when it
 * is not wired (e.g. existing tests), the tech path behaves exactly as
 * before. Customer-intake failures are isolated here so they can never
 * turn an acknowledged Twilio delivery into a queue retry that would
 * re-run the tech path.
 */
import type { WorkerHandler, QueueMessage } from '../queues/queue';
import type { Logger } from '../logging/logger';
import {
  ingestInboundMms,
  MMS_INGEST_QUEUE_TYPE,
  type MmsIngestDeps,
  type MmsIngestQueuePayload,
} from '../sms/tech-status/mms-ingest';
import {
  ingestCustomerMms,
  type CustomerMmsIntakeDeps,
} from '../sms/customer-mms/customer-mms-intake';

export interface MmsIngestWorkerDeps extends MmsIngestDeps {
  /**
   * U2 — customer MMS-to-quote intake. Invoked only when the tech
   * pipeline declines the sender (`ignored_non_tech`). Optional so the
   * tech-only path keeps working when the customer path isn't configured.
   */
  customerIntake?: CustomerMmsIntakeDeps;
}

export function createMmsIngestWorker(
  deps: MmsIngestWorkerDeps,
): WorkerHandler<MmsIngestQueuePayload> {
  return {
    type: MMS_INGEST_QUEUE_TYPE,
    async handle(message: QueueMessage<MmsIngestQueuePayload>, logger: Logger): Promise<void> {
      const { v, tenantId, fromPhone, messageSid, mediaItems, body } = message.payload ?? {};
      // Accept v:1 or absent (legacy in-flight messages that pre-date the
      // version field); any other explicit version is rejected as unknown.
      if (v !== undefined && v !== 1) {
        logger.error('mms_ingest: unknown payload version — dropping', {
          messageId: message.id,
          v,
        });
        return;
      }
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

      const ctx = {
        tenantId,
        fromE164: fromPhone,
        // The tech path ignores the body; the customer path uses it for the
        // estimate context. Absent (legacy/no-text MMS) → empty string.
        body: typeof body === 'string' ? body : '',
        messageSid,
        media: mediaItems,
      };
      const result = await ingestInboundMms(ctx, { ...deps, logger: deps.logger ?? logger });

      logger.info('mms_ingest: processed inbound MMS', {
        tenantId,
        messageSid,
        outcome: result.outcome,
        stored: result.stored,
        skipped: result.skipped,
      });

      // U2 — the sender wasn't a registered tech: try the customer
      // MMS-to-quote path (resolve/create customer → draft_estimate
      // proposal). Isolated so an intake failure never retries the whole
      // message (which would re-run the tech path) — it rides as a logged
      // best-effort, exactly like the tech per-item isolation.
      if (result.outcome === 'ignored_non_tech' && deps.customerIntake) {
        try {
          const intake = await ingestCustomerMms(ctx, {
            ...deps.customerIntake,
            logger: deps.customerIntake.logger ?? logger,
          });
          logger.info('mms_ingest: processed customer MMS-to-quote', {
            tenantId,
            messageSid,
            outcome: intake.outcome,
            proposalId: intake.proposalId,
            storedImages: intake.storedImages,
          });
        } catch (err) {
          logger.error('mms_ingest: customer MMS-to-quote failed (isolated)', {
            tenantId,
            messageSid,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    },
  };
}
