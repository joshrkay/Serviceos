import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  handleInboundMmsPhotos,
  InboundMmsContext,
  JobPhotoIngestDeps,
} from '../../../src/sms/job-photo/handler';
import { InMemoryUserRepository, User } from '../../../src/users/user';
import { InMemoryJobRepository, Job, JobStatus } from '../../../src/jobs/job';
import { InMemoryJobPhotoRepository } from '../../../src/jobs/job-photo';
import { InMemoryFileRepository, StorageProvider } from '../../../src/files/file-service';
import { InMemoryAuditRepository } from '../../../src/audit/audit';
import { InMemoryDeliveryProvider } from '../../../src/notifications/delivery-provider';
import type { DownloadMediaResult } from '../../../src/integrations/twilio/media';

const TENANT = '11111111-1111-1111-1111-111111111111';
const TECH = '22222222-2222-2222-2222-222222222222';
const TECH_MOBILE = '+15551230001';

function fakeStorage(): StorageProvider {
  return {
    generateUploadUrl: async () => 'u',
    generateDownloadUrl: async () => 'u',
    getObjectMetadata: async () => null,
    deleteObject: async () => {},
    putObject: async () => {},
  };
}

let jobSeq = 0;
function job(overrides: Partial<Job> = {}): Job {
  jobSeq += 1;
  return {
    id: `job-${jobSeq}`,
    tenantId: TENANT,
    customerId: 'c-1',
    locationId: 'loc-1',
    jobNumber: `JOB-${jobSeq}`,
    summary: 'Henderson water heater',
    status: 'in_progress' as JobStatus,
    priority: 'normal',
    assignedTechnicianId: TECH,
    createdBy: 'system',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

const okDownload = (): DownloadMediaResult => ({
  ok: true,
  media: { buffer: Buffer.from('JPEGDATA'), contentType: 'image/jpeg' },
});

interface Harness {
  deps: JobPhotoIngestDeps;
  jobPhotoRepo: InMemoryJobPhotoRepository;
  fileRepo: InMemoryFileRepository;
  delivery: InMemoryDeliveryProvider;
  auditRepo: InMemoryAuditRepository;
  jobRepo: InMemoryJobRepository;
  download: ReturnType<typeof vi.fn>;
}

async function buildHarness(
  jobs: Job[],
  downloadImpl: () => DownloadMediaResult | Promise<DownloadMediaResult> = okDownload,
): Promise<Harness> {
  const userRepo = new InMemoryUserRepository();
  const tech: Omit<User, 'createdAt' | 'updatedAt'> = {
    id: TECH,
    tenantId: TENANT,
    email: 'tech@example.com',
    role: 'technician',
    canFieldServe: true,
    mobileNumber: TECH_MOBILE,
  };
  await userRepo.create(tech);

  const jobRepo = new InMemoryJobRepository();
  for (const j of jobs) await jobRepo.create(j);

  const jobPhotoRepo = new InMemoryJobPhotoRepository();
  const fileRepo = new InMemoryFileRepository();
  const delivery = new InMemoryDeliveryProvider();
  const auditRepo = new InMemoryAuditRepository();
  const download = vi.fn(async () => downloadImpl());

  return {
    jobPhotoRepo,
    fileRepo,
    delivery,
    auditRepo,
    jobRepo,
    download,
    deps: {
      userRepo,
      jobRepo,
      jobPhotoRepo,
      fileRepo,
      storage: fakeStorage(),
      bucket: 'media',
      messageDelivery: delivery,
      auditRepo,
      downloadMedia: download as unknown as JobPhotoIngestDeps['downloadMedia'],
      now: () => new Date('2026-06-14T12:00:00Z'),
    },
  };
}

function ctx(overrides: Partial<InboundMmsContext> = {}): InboundMmsContext {
  return {
    tenantId: TENANT,
    fromE164: TECH_MOBILE,
    body: '',
    messageSid: 'MM1',
    media: [{ url: 'https://media.twiliocdn.com/a', contentType: 'image/jpeg' }],
    accountSid: 'AC1',
    authToken: 'tok',
    ...overrides,
  };
}

describe('handleInboundMmsPhotos', () => {
  beforeEach(() => {
    jobSeq = 0;
  });

  it('attaches a photo to the tech\'s single active job + confirms', async () => {
    const h = await buildHarness([job({ id: 'j1' })]);

    const result = await handleInboundMmsPhotos(ctx(), h.deps);

    expect(result).toMatchObject({ handled: true, attached: 1, reason: 'attached' });
    const photos = await h.jobPhotoRepo.listByJob(TENANT, 'j1');
    expect(photos).toHaveLength(1);
    expect(photos[0].uploadedByUserId).toBe(TECH);
    expect(photos[0].category).toBe('other');
    // A file row was stored and linked.
    expect(await h.fileRepo.findById(TENANT, photos[0].fileId)).not.toBeNull();
    // Confirmation text.
    expect(h.delivery.sentSms).toHaveLength(1);
    expect(h.delivery.sentSms[0].body).toContain('Saved 1 photo');
    expect(h.auditRepo.getAll().some((e) => e.eventType === 'job_photo.attached')).toBe(true);
  });

  it('uses the caption category and job reference', async () => {
    const h = await buildHarness([
      job({ id: 'a', summary: 'Henderson water heater' }),
      job({ id: 'b', summary: 'Miller furnace' }),
    ]);

    const result = await handleInboundMmsPhotos(ctx({ body: 'Miller before' }), h.deps);

    expect(result.attached).toBe(1);
    const photos = await h.jobPhotoRepo.listByJob(TENANT, 'b');
    expect(photos).toHaveLength(1);
    expect(photos[0].category).toBe('before');
    expect(await h.jobPhotoRepo.listByJob(TENANT, 'a')).toHaveLength(0);
  });

  it('never downloads media from an unverified number (and does not reply)', async () => {
    const h = await buildHarness([job({ id: 'j1' })]);

    const result = await handleInboundMmsPhotos(ctx({ fromE164: '+15559999999' }), h.deps);

    expect(result).toMatchObject({ handled: false, reason: 'unknown_mobile' });
    expect(h.download).not.toHaveBeenCalled();
    expect(h.delivery.sentSms).toHaveLength(0);
    expect(await h.jobPhotoRepo.listByJob(TENANT, 'j1')).toHaveLength(0);
  });

  it('asks which job when the photo is ambiguous (no reference, several active)', async () => {
    const h = await buildHarness([
      job({ id: 'a', status: 'scheduled', summary: 'Smith one' }),
      job({ id: 'b', status: 'scheduled', summary: 'Smith two' }),
    ]);

    const result = await handleInboundMmsPhotos(ctx({ body: '' }), h.deps);

    expect(result).toMatchObject({ handled: true, attached: 0, reason: 'job_unresolved' });
    expect(h.delivery.sentSms[0].body).toMatch(/which job/i);
    expect(h.download).not.toHaveBeenCalled();
  });

  it('skips non-image / failed downloads and reports when none stored', async () => {
    const h = await buildHarness([job({ id: 'j1' })], () => ({ ok: false, reason: 'not_image' }));

    const result = await handleInboundMmsPhotos(ctx(), h.deps);

    expect(result).toMatchObject({ handled: true, attached: 0, reason: 'no_photos_stored' });
    expect(h.delivery.sentSms[0].body).toMatch(/couldn't process/i);
    expect(await h.jobPhotoRepo.listByJob(TENANT, 'j1')).toHaveLength(0);
  });

  it('attaches multiple images in one MMS', async () => {
    const h = await buildHarness([job({ id: 'j1' })]);

    const result = await handleInboundMmsPhotos(
      ctx({
        media: [
          { url: 'https://media.twiliocdn.com/a', contentType: 'image/jpeg' },
          { url: 'https://media.twiliocdn.com/b', contentType: 'image/png' },
        ],
      }),
      h.deps,
    );

    expect(result.attached).toBe(2);
    expect(await h.jobPhotoRepo.listByJob(TENANT, 'j1')).toHaveLength(2);
    expect(h.delivery.sentSms[0].body).toContain('Saved 2 photos');
  });
});
