/**
 * RV-050 / P0-009 — async MMS ingestion worker.
 *
 * The webhook seam enqueues {tenantId, fromPhone, messageSid, mediaItems};
 * this worker runs the FULL pipeline (identity gate → active job → fetch →
 * store → attach) via ingestInboundMms, off the webhook request. The
 * "clock in first" reply is sent from here through the async outbound SMS
 * seam (MessageDelivery in production).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMmsIngestWorker } from '../../src/workers/mms-ingest-worker';
import {
  MMS_CLOCK_IN_FIRST_REPLY,
  MMS_INGEST_QUEUE_TYPE,
  mmsIngestIdempotencyKey,
  type MmsIngestDeps,
  type MmsIngestQueuePayload,
} from '../../src/sms/tech-status/mms-ingest';
import type { QueueMessage } from '../../src/queues/queue';
import { AttachmentService } from '../../src/attachments/attachment-service';
import { InMemoryAttachmentRepository } from '../../src/attachments/attachment';
import { InMemoryFileRepository } from '../../src/files/file-service';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import type { StorageProvider } from '../../src/files/file-service';
import type { TimeEntry } from '../../src/time-tracking/time-entry';
import type { User } from '../../src/users/user';
import type { Logger } from '../../src/logging/logger';

const TENANT = 't-1';
const TECH_PHONE = '+15125550111';
const JOB_ID = '11111111-1111-4111-8111-111111111111';
const TECH_ID = 'tech-1';

function makeTech(): User {
  return {
    id: TECH_ID,
    tenantId: TENANT,
    role: 'technician',
    email: 'tech@example.com',
    mobileNumber: TECH_PHONE,
  } as unknown as User;
}

function activeEntry(jobId?: string): TimeEntry {
  return {
    id: 'te-1',
    tenantId: TENANT,
    userId: TECH_ID,
    jobId,
    entryType: 'job',
    clockedInAt: new Date('2026-06-11T13:00:00Z'),
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makeStorage(): StorageProvider & { putObject: ReturnType<typeof vi.fn> } {
  return {
    generateUploadUrl: vi.fn(async () => 'https://upload'),
    generateDownloadUrl: vi.fn(async () => 'https://download'),
    getObjectMetadata: vi.fn(async () => null),
    getObject: vi.fn(async () => null),
    putObject: vi.fn() as StorageProvider['putObject'] & ReturnType<typeof vi.fn>,
    deleteObject: vi.fn(async (): Promise<void> => undefined),
  };
}

function silentLogger(): Logger {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
  } as unknown as Logger;
  (logger.child as ReturnType<typeof vi.fn>).mockReturnValue(logger);
  return logger;
}

function queueMessage(
  payload: Partial<MmsIngestQueuePayload> | unknown,
): QueueMessage<MmsIngestQueuePayload> {
  return {
    id: 'qm-1',
    type: MMS_INGEST_QUEUE_TYPE,
    payload: payload as MmsIngestQueuePayload,
    attempts: 1,
    maxAttempts: 3,
    idempotencyKey: mmsIngestIdempotencyKey('SM-mms-1'),
    createdAt: new Date().toISOString(),
  };
}

function fullPayload(): MmsIngestQueuePayload {
  return {
    tenantId: TENANT,
    fromPhone: TECH_PHONE,
    messageSid: 'SM-mms-1',
    mediaItems: [{ url: 'https://api.twilio.com/media/ME1', contentType: 'image/jpeg' }],
  };
}

describe('mms-ingest-worker (RV-050 / P0-009)', () => {
  let fileRepo: InMemoryFileRepository;
  let attachmentRepo: InMemoryAttachmentRepository;
  let auditRepo: InMemoryAuditRepository;
  let storage: ReturnType<typeof makeStorage>;
  let fetchMedia: ReturnType<typeof vi.fn>;
  let sendReply: ReturnType<typeof vi.fn>;
  let deps: MmsIngestDeps;

  beforeEach(() => {
    fileRepo = new InMemoryFileRepository();
    attachmentRepo = new InMemoryAttachmentRepository();
    auditRepo = new InMemoryAuditRepository();
    storage = makeStorage();
    fetchMedia = vi.fn(async () => ({
      bytes: Buffer.from('jpeg-bytes'),
      contentType: 'image/jpeg',
    }));
    sendReply = vi.fn(async (): Promise<void> => undefined);
    deps = {
      userRepo: { findByMobileNumber: vi.fn(async () => makeTech()) },
      timeEntries: { findActiveEntry: vi.fn(async () => activeEntry(JOB_ID)) },
      attachmentService: new AttachmentService(
        attachmentRepo,
        fileRepo,
        storage,
        auditRepo,
        { job: async () => true },
      ),
      fileRepo,
      storage,
      storageBucket: 'test-bucket',
      fetchMedia: fetchMedia as unknown as MmsIngestDeps['fetchMedia'],
      sendReply: sendReply as unknown as NonNullable<MmsIngestDeps['sendReply']>,
      auditRepo,
    };
  });

  it('registers under the mms_ingest queue type', () => {
    expect(createMmsIngestWorker(deps).type).toBe('mms_ingest');
  });

  it("consumes a queued message and attaches the photo to the tech's active job", async () => {
    const worker = createMmsIngestWorker(deps);
    await worker.handle(queueMessage(fullPayload()), silentLogger());

    expect(fetchMedia).toHaveBeenCalledWith(TENANT, 'https://api.twilio.com/media/ME1');
    expect(storage.putObject).toHaveBeenCalledTimes(1);
    const attachments = await attachmentRepo.listByEntity(TENANT, 'job', JOB_ID);
    expect(attachments).toHaveLength(1);
    expect(attachments[0].source).toBe('sms');
    expect(attachments[0].kind).toBe('photo');
  });

  it('sends the "clock in first" reply via the async SMS seam when no active job exists', async () => {
    (deps.timeEntries.findActiveEntry as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const worker = createMmsIngestWorker(deps);
    await worker.handle(queueMessage(fullPayload()), silentLogger());

    expect(sendReply).toHaveBeenCalledWith(TENANT, TECH_PHONE, MMS_CLOCK_IN_FIRST_REPLY);
    expect(fetchMedia).not.toHaveBeenCalled();
    expect(storage.putObject).not.toHaveBeenCalled();
  });

  it('identity gate runs in the worker: non-tech sender → nothing fetched, no reply', async () => {
    (deps.userRepo.findByMobileNumber as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const worker = createMmsIngestWorker(deps);
    await worker.handle(queueMessage(fullPayload()), silentLogger());

    expect(fetchMedia).not.toHaveBeenCalled();
    expect(sendReply).not.toHaveBeenCalled();
    expect(storage.putObject).not.toHaveBeenCalled();
  });

  it('drops a malformed payload without throwing (permanent, no retry)', async () => {
    const worker = createMmsIngestWorker(deps);
    const logger = silentLogger();
    await expect(
      worker.handle(queueMessage({ tenantId: TENANT }), logger),
    ).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalled();
    expect(fetchMedia).not.toHaveBeenCalled();
  });

  it('rethrows identity-gate failures into the queue retry semantics', async () => {
    (deps.userRepo.findByMobileNumber as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('db down'),
    );
    const worker = createMmsIngestWorker(deps);
    await expect(worker.handle(queueMessage(fullPayload()), silentLogger())).rejects.toThrow(
      /db down/,
    );
  });

  it('per-item fetch failures are isolated inside the pipeline (no throw, others stored)', async () => {
    fetchMedia
      .mockRejectedValueOnce(new Error('twilio 500'))
      .mockResolvedValueOnce({ bytes: Buffer.from('ok'), contentType: 'image/png' });
    const worker = createMmsIngestWorker(deps);
    await worker.handle(
      queueMessage({
        ...fullPayload(),
        mediaItems: [
          { url: 'https://api.twilio.com/media/ME1', contentType: 'image/jpeg' },
          { url: 'https://api.twilio.com/media/ME2', contentType: 'image/png' },
        ],
      }),
      silentLogger(),
    );
    const attachments = await attachmentRepo.listByEntity(TENANT, 'job', JOB_ID);
    expect(attachments).toHaveLength(1);
  });
});
