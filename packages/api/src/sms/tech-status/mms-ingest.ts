/**
 * RV-050 — inbound MMS photo ingestion from registered tech phones.
 *
 * P0-009 async split: the webhook-side media seam (registerMmsIngestHandler)
 * does NO identity lookups, NO media fetches and NO storage writes — it
 * enqueues ONE `mms_ingest` queue message ({tenantId, fromPhone,
 * messageSid, mediaItems}) keyed on the Twilio MessageSid and returns, so
 * webhook latency stays in the milliseconds and a Twilio retry-duplicate is
 * suppressed by the queue's idempotency-key dedupe instead of being lost.
 * The full pipeline below runs in src/workers/mms-ingest-worker.ts.
 *
 * Flow (in the WORKER, via ingestInboundMms):
 *   1. ANTI-SPOOFING: resolve the inbound mobile via P1-022's
 *      findByMobileNumber and require role === 'technician' — same identity
 *      rule as the tech-status handler. Non-tech senders are silently
 *      ignored (no reply, no fetch — the URL is attacker-controlled input
 *      until the sender is verified).
 *   2. Resolve the tech's ACTIVE job: their open time entry's job_id. No
 *      active job-typed entry → reply "clock in first or use the app"
 *      (sent through the async outbound SMS dispatch seam — the same
 *      MessageDelivery transport, now off the webhook request) and skip
 *      (nothing is stored against a guessed job).
 *   3. Per media item: download via the Twilio media URL (Basic-auth
 *      fetcher seam — same credential pattern as the recording webhook's
 *      fetchRecordingBytes), store the bytes through the files pipeline
 *      (FileRecord + StorageProvider.putObject), then attach to the job via
 *      the AttachmentService (source 'sms', kind 'photo', category 'other'
 *      — emits the standard attachment.uploaded audit event).
 *
 * Failure isolation is layered: ingestInboundMms never throws for per-item
 * failures (fetch/store errors are logged and skipped), the dispatcher
 * wraps the enqueue so even a queue outage can never break normal SMS
 * handling, and worker-level errors ride the queue's retry/DLQ semantics.
 */
import type { InboundSmsContext, InboundSmsMedia } from '../inbound-dispatch';
import {
  registerMediaHandler,
  type RegisterKeywordHandlerOptions,
  type MediaHandler,
} from '../inbound-dispatch';
import type { Queue } from '../../queues/queue';
import type { UserRepository } from '../../users/user';
import type { TimeEntryService } from '../../time-tracking/time-entry-service';
import type { AttachmentService } from '../../attachments/attachment-service';
import {
  createFileRecord,
  normalizeContentType,
  type FileRepository,
  type StorageProvider,
} from '../../files/file-service';
import { AuditRepository, createAuditEvent } from '../../audit/audit';
import { createLogger, type Logger } from '../../logging/logger';

const defaultLogger = createLogger({
  service: 'sms-mms-ingest',
  environment: process.env.NODE_ENV || 'dev',
});

/** Reply sent when a tech texts a photo without an open job-clocked entry. */
export const MMS_CLOCK_IN_FIRST_REPLY =
  'No active job found — clock in first or use the app to attach photos.';

export interface FetchedMedia {
  bytes: Buffer;
  /** Content type as reported by the provider (response header). */
  contentType?: string;
}

/** Seam: download one media item. Production uses createTwilioMediaFetcher. */
export type MediaFetcher = (tenantId: string, url: string) => Promise<FetchedMedia | null>;

export interface MmsIngestDeps {
  userRepo: Pick<UserRepository, 'findByMobileNumber'>;
  timeEntries: Pick<TimeEntryService, 'findActiveEntry'>;
  attachmentService: Pick<AttachmentService, 'attach'>;
  fileRepo: Pick<FileRepository, 'create'>;
  storage: Pick<StorageProvider, 'putObject'>;
  storageBucket: string;
  fetchMedia: MediaFetcher;
  /** Outbound reply transport ("clock in first"). Absent → reply skipped. */
  sendReply?: (tenantId: string, toE164: string, body: string) => Promise<void>;
  auditRepo?: AuditRepository;
  logger?: Logger;
}

export type MmsIngestOutcome =
  | 'ignored_no_media'
  | 'ignored_non_tech'
  | 'no_active_job'
  | 'stored';

export interface MmsIngestResult {
  outcome: MmsIngestOutcome;
  stored: number;
  /** Items skipped (non-image type, fetch failure, store failure). */
  skipped: number;
}

const EXTENSION_BY_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

export async function ingestInboundMms(
  ctx: InboundSmsContext,
  deps: MmsIngestDeps,
): Promise<MmsIngestResult> {
  const logger = deps.logger ?? defaultLogger;
  const media = ctx.media ?? [];
  if (media.length === 0) return { outcome: 'ignored_no_media', stored: 0, skipped: 0 };

  // 1. Sender identity — only REGISTERED TECH phones ingest photos.
  const user = await deps.userRepo.findByMobileNumber(ctx.tenantId, ctx.fromE164);
  if (!user || user.role !== 'technician') {
    return { outcome: 'ignored_non_tech', stored: 0, skipped: media.length };
  }

  // 2. Active job = the tech's open time entry's job_id.
  const active = await deps.timeEntries.findActiveEntry(ctx.tenantId, user.id);
  const jobId = active?.jobId;
  if (!jobId) {
    if (deps.sendReply) {
      try {
        await deps.sendReply(ctx.tenantId, ctx.fromE164, MMS_CLOCK_IN_FIRST_REPLY);
      } catch (err) {
        logger.warn('MMS ingest: clock-in-first reply failed', {
          tenantId: ctx.tenantId,
          messageSid: ctx.messageSid,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { outcome: 'no_active_job', stored: 0, skipped: media.length };
  }

  // 3. Download + store each item; one bad item never skips the rest.
  let stored = 0;
  let skipped = 0;
  for (let i = 0; i < media.length; i++) {
    const item = media[i];
    try {
      // Pre-filter on the declared type when present (saves the fetch);
      // re-checked against the fetched type below.
      if (item.contentType && !isSupportedImage(item.contentType)) {
        skipped++;
        continue;
      }
      const fetched = await deps.fetchMedia(ctx.tenantId, item.url);
      if (!fetched) {
        skipped++;
        continue;
      }
      const contentType = normalizeContentType(
        fetched.contentType ?? item.contentType ?? '',
      );
      if (!isSupportedImage(contentType)) {
        skipped++;
        continue;
      }

      const record = createFileRecord(
        {
          tenantId: ctx.tenantId,
          filename: `mms-${ctx.messageSid}-${i}.${EXTENSION_BY_TYPE[contentType]}`,
          contentType,
          sizeBytes: fetched.bytes.length,
          entityType: 'job',
          entityId: jobId,
          uploadedBy: user.id,
        },
        deps.storageBucket,
      );
      await deps.storage.putObject(record.storageBucket, record.storageKey, fetched.bytes, contentType);
      await deps.fileRepo.create(record);
      await deps.attachmentService.attach(
        ctx.tenantId,
        { userId: user.id, role: 'technician' },
        {
          fileId: record.id,
          entityType: 'job',
          entityId: jobId,
          kind: 'photo',
          category: 'other',
          source: 'sms',
        },
      );
      stored++;
    } catch (err) {
      skipped++;
      logger.warn('MMS ingest: media item failed', {
        tenantId: ctx.tenantId,
        messageSid: ctx.messageSid,
        mediaIndex: i,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (stored > 0 && deps.auditRepo) {
    try {
      await deps.auditRepo.create(
        createAuditEvent({
          tenantId: ctx.tenantId,
          actorId: user.id,
          actorRole: 'technician',
          eventType: 'sms.mms_photos_ingested',
          entityType: 'job',
          entityId: jobId,
          metadata: { messageSid: ctx.messageSid, stored, skipped },
        }),
      );
    } catch {
      // Best-effort summary audit; per-attachment audits already exist.
    }
  }

  return { outcome: 'stored', stored, skipped };
}

function isSupportedImage(contentType: string): boolean {
  return Object.prototype.hasOwnProperty.call(EXTENSION_BY_TYPE, normalizeContentType(contentType));
}

/**
 * Production media fetcher: Twilio media URLs require Basic auth with the
 * (sub)account SID + auth token — the same credential pattern the recording
 * webhook's fetchRecordingBytes uses. The credentials resolver returns null
 * when the tenant has no Twilio integration, which skips the item.
 */
export function createTwilioMediaFetcher(
  resolveCredentials: (
    tenantId: string,
  ) => Promise<{ accountSid: string; authToken: string } | null>,
  fetchFn: typeof fetch = fetch,
): MediaFetcher {
  return async (tenantId, url) => {
    const creds = await resolveCredentials(tenantId);
    if (!creds) return null;
    const basic = Buffer.from(`${creds.accountSid}:${creds.authToken}`).toString('base64');
    const res = await fetchFn(url, {
      method: 'GET',
      headers: { Authorization: `Basic ${basic}` },
      redirect: 'follow',
    });
    if (!res.ok) {
      // Never echo the URL/credentials into the error.
      throw new Error(`Twilio media fetch failed ${res.status}`);
    }
    const contentType = res.headers.get('content-type') ?? undefined;
    const bytes = Buffer.from(await res.arrayBuffer());
    return { bytes, ...(contentType ? { contentType } : {}) };
  };
}

// ── P0-009 — webhook-side enqueue seam ─────────────────────────────────────

/** Queue message type consumed by src/workers/mms-ingest-worker.ts. */
export const MMS_INGEST_QUEUE_TYPE = 'mms_ingest';

/** Payload of one enqueued inbound-MMS ingestion job. */
export interface MmsIngestQueuePayload {
  tenantId: string;
  /** Sender in E.164 — identity-gated by the worker, not the webhook. */
  fromPhone: string;
  /** Twilio MessageSid — also drives the idempotency key. */
  messageSid: string;
  mediaItems: InboundSmsMedia[];
}

/**
 * Idempotency key for the enqueue: Twilio MessageSids are globally unique,
 * so a webhook retry-duplicate for the same inbound MMS collapses onto the
 * already-queued job (PgQueue: ON CONFLICT (idempotency_key) DO NOTHING).
 */
export function mmsIngestIdempotencyKey(messageSid: string): string {
  return `${MMS_INGEST_QUEUE_TYPE}:${messageSid}`;
}

export interface MmsIngestEnqueueDeps {
  queue: Pick<Queue, 'send'>;
  logger?: Logger;
}

/**
 * Module init — register the MMS media handler with the P2-034 dispatcher.
 * P0-009: the handler only ENQUEUES (no identity lookup, no fetch, no
 * storage write on the webhook request); the worker owns the pipeline.
 * Mirrors registerTechStatusKeywords; `overwrite` allows repeated createApp
 * calls in the same process (tests).
 */
export function registerMmsIngestHandler(
  deps: MmsIngestEnqueueDeps,
  options: RegisterKeywordHandlerOptions = {},
): MediaHandler {
  const handler: MediaHandler = {
    name: 'tech-mms-ingest',
    handle: async (ctx: InboundSmsContext) => {
      const media = ctx.media ?? [];
      if (media.length === 0) return { outcome: 'ignored_no_media' };
      const payload: MmsIngestQueuePayload = {
        tenantId: ctx.tenantId,
        fromPhone: ctx.fromE164,
        messageSid: ctx.messageSid,
        mediaItems: media.map((m) => ({ ...m })),
      };
      const messageId = await deps.queue.send(
        MMS_INGEST_QUEUE_TYPE,
        payload,
        mmsIngestIdempotencyKey(ctx.messageSid),
      );
      return { outcome: 'enqueued', messageId };
    },
  };
  registerMediaHandler(handler, options);
  return handler;
}
