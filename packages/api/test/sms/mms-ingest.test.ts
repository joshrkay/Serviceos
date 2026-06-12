/**
 * RV-050 — inbound MMS photo ingestion from registered tech phones.
 *
 * Covers: happy path (tech + active job → fetched, stored via the files
 * pipeline, attached via AttachmentService with source 'sms' / kind 'photo'
 * / category 'other'), no-active-job reply, non-tech sender ignored, fetch
 * failure isolation (incl. at the dispatcher boundary), and the Twilio
 * Basic-auth fetcher seam.
 *
 * P0-009: the dispatcher-facing seam (registerMmsIngestHandler) now only
 * ENQUEUES an `mms_ingest` job keyed on the MessageSid; the pipeline above
 * runs in the worker (see test/workers/mms-ingest-worker.test.ts).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ingestInboundMms,
  registerMmsIngestHandler,
  createTwilioMediaFetcher,
  mmsIngestIdempotencyKey,
  MMS_CLOCK_IN_FIRST_REPLY,
  MMS_INGEST_QUEUE_TYPE,
  type MmsIngestDeps,
  type MmsIngestQueuePayload,
} from '../../src/sms/tech-status/mms-ingest';
import {
  dispatchInboundSms,
  registerKeywordHandler,
  __resetKeywordRegistryForTests,
  type InboundSmsContext,
} from '../../src/sms/inbound-dispatch';
import { AttachmentService } from '../../src/attachments/attachment-service';
import { InMemoryAttachmentRepository } from '../../src/attachments/attachment';
import { InMemoryFileRepository } from '../../src/files/file-service';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import type { StorageProvider } from '../../src/files/file-service';
import type { TimeEntry } from '../../src/time-tracking/time-entry';
import type { User } from '../../src/users/user';

const TENANT = 't-1';
const TECH_PHONE = '+15125550111';
const JOB_ID = '11111111-1111-4111-8111-111111111111';
const TECH_ID = 'tech-1';

function makeTech(overrides: Partial<User> = {}): User {
  return {
    id: TECH_ID,
    tenantId: TENANT,
    role: 'technician',
    email: 'tech@example.com',
    mobileNumber: TECH_PHONE,
    ...overrides,
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

function ctx(overrides: Partial<InboundSmsContext> = {}): InboundSmsContext {
  return {
    tenantId: TENANT,
    fromE164: TECH_PHONE,
    body: '',
    messageSid: 'SM-mms-1',
    media: [{ url: 'https://api.twilio.com/media/ME1', contentType: 'image/jpeg' }],
    ...overrides,
  };
}

describe('ingestInboundMms (RV-050)', () => {
  type FetchMediaMock = MmsIngestDeps['fetchMedia'] & ReturnType<typeof vi.fn>;
  type SendReplyMock = NonNullable<MmsIngestDeps['sendReply']> & ReturnType<typeof vi.fn>;

  let fileRepo: InMemoryFileRepository;
  let attachmentRepo: InMemoryAttachmentRepository;
  let auditRepo: InMemoryAuditRepository;
  let storage: ReturnType<typeof makeStorage>;
  let fetchMedia: FetchMediaMock;
  let sendReply: SendReplyMock;
  let deps: MmsIngestDeps;

  beforeEach(() => {
    fileRepo = new InMemoryFileRepository();
    attachmentRepo = new InMemoryAttachmentRepository();
    auditRepo = new InMemoryAuditRepository();
    storage = makeStorage();
    fetchMedia = vi.fn(async () => ({
      bytes: Buffer.from('jpeg-bytes'),
      contentType: 'image/jpeg',
    })) as FetchMediaMock;
    sendReply = vi.fn(async (): Promise<void> => undefined) as SendReplyMock;
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
      fetchMedia,
      sendReply,
      auditRepo,
    };
  });

  it("stores the photo on the tech's ACTIVE job via the attachments service", async () => {
    const result = await ingestInboundMms(ctx(), deps);
    expect(result).toEqual({ outcome: 'stored', stored: 1, skipped: 0 });

    expect(fetchMedia).toHaveBeenCalledWith(TENANT, 'https://api.twilio.com/media/ME1');
    expect(storage.putObject).toHaveBeenCalledTimes(1);

    const attachments = await attachmentRepo.listByEntity(TENANT, 'job', JOB_ID);
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({
      entityType: 'job',
      entityId: JOB_ID,
      kind: 'photo',
      category: 'other',
      source: 'sms',
      uploadedBy: TECH_ID,
    });

    const file = await fileRepo.findById(TENANT, attachments[0].fileId);
    expect(file).toMatchObject({
      entityType: 'job',
      entityId: JOB_ID,
      contentType: 'image/jpeg',
      uploadedBy: TECH_ID,
    });
    expect(file!.filename).toBe('mms-SM-mms-1-0.jpg');

    expect(sendReply).not.toHaveBeenCalled();
    const types = auditRepo.getAll().map((e) => e.eventType);
    expect(types).toContain('attachment.uploaded');
    expect(types).toContain('sms.mms_photos_ingested');
  });

  it('stores multiple media items, skipping non-image attachments', async () => {
    const result = await ingestInboundMms(
      ctx({
        media: [
          { url: 'https://m/1', contentType: 'image/png' },
          { url: 'https://m/2', contentType: 'application/pdf' },
          { url: 'https://m/3', contentType: 'image/jpeg' },
        ],
      }),
      deps,
    );
    expect(result).toEqual({ outcome: 'stored', stored: 2, skipped: 1 });
    // The PDF was never even fetched.
    expect(fetchMedia).toHaveBeenCalledTimes(2);
  });

  it('replies "clock in first" and stores nothing when the tech has no active job', async () => {
    deps.timeEntries = { findActiveEntry: vi.fn(async () => null) };
    const result = await ingestInboundMms(ctx(), deps);
    expect(result).toEqual({ outcome: 'no_active_job', stored: 0, skipped: 1 });
    expect(sendReply).toHaveBeenCalledWith(TENANT, TECH_PHONE, MMS_CLOCK_IN_FIRST_REPLY);
    expect(fetchMedia).not.toHaveBeenCalled();
    expect(await attachmentRepo.listByEntity(TENANT, 'job', JOB_ID)).toHaveLength(0);
  });

  it('a non-job entry (e.g. break) counts as no active job', async () => {
    deps.timeEntries = { findActiveEntry: vi.fn(async () => activeEntry(undefined)) };
    const result = await ingestInboundMms(ctx(), deps);
    expect(result.outcome).toBe('no_active_job');
    expect(sendReply).toHaveBeenCalledTimes(1);
  });

  it('ignores non-tech senders silently: no reply, no fetch, nothing stored', async () => {
    deps.userRepo = {
      findByMobileNumber: vi.fn(async () => makeTech({ role: 'owner' } as Partial<User>)),
    };
    const result = await ingestInboundMms(ctx(), deps);
    expect(result).toEqual({ outcome: 'ignored_non_tech', stored: 0, skipped: 1 });
    expect(sendReply).not.toHaveBeenCalled();
    expect(fetchMedia).not.toHaveBeenCalled();
  });

  it('ignores unknown mobile numbers', async () => {
    deps.userRepo = { findByMobileNumber: vi.fn(async () => null) };
    const result = await ingestInboundMms(ctx(), deps);
    expect(result.outcome).toBe('ignored_non_tech');
    expect(fetchMedia).not.toHaveBeenCalled();
  });

  it('isolates a fetch failure: the failed item is skipped, the rest still store', async () => {
    fetchMedia
      .mockRejectedValueOnce(new Error('Twilio media fetch failed 503'))
      .mockResolvedValueOnce({ bytes: Buffer.from('ok'), contentType: 'image/jpeg' });
    const result = await ingestInboundMms(
      ctx({
        media: [
          { url: 'https://m/fails', contentType: 'image/jpeg' },
          { url: 'https://m/works', contentType: 'image/jpeg' },
        ],
      }),
      deps,
    );
    expect(result).toEqual({ outcome: 'stored', stored: 1, skipped: 1 });
    expect(await attachmentRepo.listByEntity(TENANT, 'job', JOB_ID)).toHaveLength(1);
  });

  it('a failed clock-in-first reply never throws', async () => {
    deps.timeEntries = { findActiveEntry: vi.fn(async () => null) };
    deps.sendReply = vi.fn(async () => {
      throw new Error('delivery down');
    });
    await expect(ingestInboundMms(ctx(), deps)).resolves.toMatchObject({
      outcome: 'no_active_job',
    });
  });
});

describe('dispatcher media integration (RV-050)', () => {
  afterEach(() => __resetKeywordRegistryForTests());

  it('a photo-only message (empty body) still ingests; SMS result unchanged', async () => {
    const handle = vi.fn(async () => undefined);
    const { registerMediaHandler } = await import('../../src/sms/inbound-dispatch');
    registerMediaHandler({ name: 'spy', handle });

    const result = await dispatchInboundSms(ctx({ body: '' }));
    expect(handle).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ handled: false, reason: 'no_matching_handler' });
  });

  it('registerMmsIngestHandler ENQUEUES an mms_ingest job (P0-009) — no inline pipeline work', async () => {
    const send = vi.fn(async () => 'msg-1');
    registerMmsIngestHandler({ queue: { send } }, { overwrite: true });

    await dispatchInboundSms(ctx({ body: '' }));

    expect(send).toHaveBeenCalledTimes(1);
    const [type, payload, idempotencyKey] = send.mock.calls[0] as unknown as [
      string,
      MmsIngestQueuePayload,
      string,
    ];
    expect(type).toBe(MMS_INGEST_QUEUE_TYPE);
    expect(payload).toEqual({
      v: 1,
      tenantId: TENANT,
      fromPhone: TECH_PHONE,
      messageSid: 'SM-mms-1',
      mediaItems: [{ url: 'https://api.twilio.com/media/ME1', contentType: 'image/jpeg' }],
    });
    expect(idempotencyKey).toBe(mmsIngestIdempotencyKey('SM-mms-1'));
  });

  it('a Twilio retry-duplicate enqueues with the SAME idempotency key (queue dedupes it)', async () => {
    const send = vi.fn(async () => 'msg-1');
    registerMmsIngestHandler({ queue: { send } }, { overwrite: true });

    await dispatchInboundSms(ctx({ body: '' }));
    await dispatchInboundSms(ctx({ body: '' })); // webhook retry, same MessageSid

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0][2]).toBe(send.mock.calls[1][2]);
    expect(send.mock.calls[0][2]).toBe(`${MMS_INGEST_QUEUE_TYPE}:SM-mms-1`);
  });

  it('a queue outage never breaks SMS handling (dispatcher isolation)', async () => {
    const send = vi.fn(async () => {
      throw new Error('queue down');
    });
    registerMmsIngestHandler({ queue: { send } }, { overwrite: true });
    registerKeywordHandler({
      keywords: ['out'],
      handle: async () => ({ handled: true, handler: 'tech-status', reason: 'recorded' }),
    });

    const result = await dispatchInboundSms(ctx({ body: 'OUT' }));
    expect(result).toEqual({ handled: true, handler: 'tech-status', reason: 'recorded' });
  });

  it('media ingestion failures never break keyword handling', async () => {
    const { registerMediaHandler } = await import('../../src/sms/inbound-dispatch');
    registerMediaHandler({
      name: 'exploding',
      handle: async () => {
        throw new Error('media pipeline exploded');
      },
    });
    registerKeywordHandler({
      keywords: ['out'],
      handle: async () => ({ handled: true, handler: 'tech-status', reason: 'recorded' }),
    });

    const result = await dispatchInboundSms(ctx({ body: 'OUT' }));
    expect(result).toEqual({ handled: true, handler: 'tech-status', reason: 'recorded' });
  });

  it('messages without media never invoke the media handler', async () => {
    const handle = vi.fn(async () => undefined);
    const { registerMediaHandler } = await import('../../src/sms/inbound-dispatch');
    registerMediaHandler({ name: 'spy', handle });
    await dispatchInboundSms(ctx({ body: 'hello', media: undefined }));
    expect(handle).not.toHaveBeenCalled();
  });
});

describe('createTwilioMediaFetcher (RV-050)', () => {
  it('fetches with subaccount Basic auth and returns bytes + content type', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      headers: { get: (h: string) => (h === 'content-type' ? 'image/jpeg' : null) },
      arrayBuffer: async () => Buffer.from('img').buffer.slice(0, 3),
    })) as unknown as typeof fetch;
    const fetcher = createTwilioMediaFetcher(
      async () => ({ accountSid: 'AC123', authToken: 'tok456' }),
      fetchFn,
    );

    const fetched = await fetcher(TENANT, 'https://api.twilio.com/media/ME1');
    expect(fetched).not.toBeNull();
    expect(fetched!.contentType).toBe('image/jpeg');

    const [, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const expected = `Basic ${Buffer.from('AC123:tok456').toString('base64')}`;
    expect((init as { headers: Record<string, string> }).headers.Authorization).toBe(expected);
  });

  it('returns null when the tenant has no Twilio credentials (item skipped)', async () => {
    const fetchFn = vi.fn() as unknown as typeof fetch;
    const fetcher = createTwilioMediaFetcher(async () => null, fetchFn);
    expect(await fetcher(TENANT, 'https://x')).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('throws a status-only error on a failed fetch (no URL/credential echo)', async () => {
    const fetchFn = vi.fn(async () => ({ ok: false, status: 404 })) as unknown as typeof fetch;
    const fetcher = createTwilioMediaFetcher(
      async () => ({ accountSid: 'AC123', authToken: 'super-secret' }),
      fetchFn,
    );
    await expect(fetcher(TENANT, 'https://x')).rejects.toThrow(/^Twilio media fetch failed 404$/);
  });
});
