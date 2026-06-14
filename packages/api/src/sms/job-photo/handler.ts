/**
 * Inbound MMS → job photo. A field tech texts a photo (with an optional
 * caption like "Henderson before") to the tenant's number; we verify the
 * sender, resolve which job it belongs to, securely download + store each
 * image, and attach it as a JobPhoto — then text back a confirmation.
 *
 * NEVER throws — the inbound webhook must return 200 (a 5xx makes Twilio
 * retry an already-acknowledged message). Media is only downloaded for a
 * VERIFIED tenant user (we never fetch media on behalf of a stranger).
 */
import { UserRepository } from '../../users/user';
import { Job, JobRepository } from '../../jobs/job';
import { JobPhotoRepository } from '../../jobs/job-photo';
import { FileRepository, StorageProvider, storeFileBytes } from '../../files/file-service';
import { AuditRepository, createAuditEvent } from '../../audit/audit';
import { MessageDeliveryProvider } from '../../notifications/delivery-provider';
import { createLogger } from '../../logging/logger';
import { downloadTwilioMedia, InboundMediaItem } from '../../integrations/twilio/media';
import { parsePhotoCaption } from '../../jobs/photo-caption';

const logger = createLogger({
  service: 'sms-job-photo',
  environment: process.env.NODE_ENV || 'dev',
});

export interface InboundMmsContext {
  tenantId: string;
  fromE164: string;
  body: string;
  messageSid: string;
  media: InboundMediaItem[];
  /** Twilio subaccount SID + auth token — used to authenticate the media fetch. */
  accountSid: string;
  authToken: string;
}

export interface JobPhotoIngestDeps {
  userRepo: UserRepository;
  jobRepo: JobRepository;
  jobPhotoRepo: JobPhotoRepository;
  fileRepo: FileRepository;
  storage: StorageProvider;
  bucket: string;
  messageDelivery?: MessageDeliveryProvider;
  auditRepo?: AuditRepository;
  /** Injectable media downloader for tests; defaults to the real one. */
  downloadMedia?: typeof downloadTwilioMedia;
  now?: () => Date;
}

export interface MmsIngestResult {
  handled: boolean;
  attached: number;
  reason?: string;
}

const EXT_BY_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

/**
 * Resolve which job a photo belongs to. Prefers the sender's own
 * non-terminal jobs; narrows by a spoken reference; with no reference,
 * prefers a single in_progress job. Returns undefined when zero or >1
 * remain (ambiguous → ask, never guess).
 */
async function resolveJobForPhoto(
  jobRepo: JobRepository,
  tenantId: string,
  opts: { technicianId?: string; jobReference?: string },
): Promise<Job | undefined> {
  const all = await jobRepo.findByTenant(tenantId);
  let candidates = all.filter((j) => j.status !== 'completed' && j.status !== 'canceled');

  if (opts.technicianId) {
    const mine = candidates.filter((j) => j.assignedTechnicianId === opts.technicianId);
    if (mine.length > 0) candidates = mine;
  }

  if (opts.jobReference) {
    const ref = opts.jobReference.toLowerCase();
    candidates = candidates.filter((j) => {
      const s = j.summary.toLowerCase();
      return s.includes(ref) || ref.includes(s);
    });
  } else {
    const inProgress = candidates.filter((j) => j.status === 'in_progress');
    if (inProgress.length > 0) candidates = inProgress;
  }

  return candidates.length === 1 ? candidates[0] : undefined;
}

async function reply(
  deps: JobPhotoIngestDeps,
  ctx: InboundMmsContext,
  body: string,
): Promise<void> {
  if (!deps.messageDelivery) return;
  try {
    await deps.messageDelivery.sendSms({
      to: ctx.fromE164,
      tenantId: ctx.tenantId,
      body,
      idempotencyKey: `job-photo-reply:${ctx.messageSid}`,
    });
  } catch (err) {
    logger.warn('sms-job-photo: reply send failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function handleInboundMmsPhotos(
  ctx: InboundMmsContext,
  deps: JobPhotoIngestDeps,
): Promise<MmsIngestResult> {
  const handler = 'job-photo';
  if (ctx.media.length === 0) return { handled: false, attached: 0, reason: 'no_media' };

  // Identity FIRST — we never download media on behalf of an unverified
  // number, and never text a stranger back.
  const user = await deps.userRepo.findByMobileNumber(ctx.tenantId, ctx.fromE164);
  if (!user) {
    if (deps.auditRepo) {
      await deps.auditRepo
        .create(
          createAuditEvent({
            tenantId: ctx.tenantId,
            actorId: ctx.messageSid,
            actorRole: 'unknown',
            eventType: 'job_photo.unverified_mobile',
            entityType: 'sms_inbound',
            entityId: ctx.messageSid,
            metadata: { fromE164: ctx.fromE164 },
          }),
        )
        .catch(() => {});
    }
    return { handled: false, attached: 0, reason: 'unknown_mobile' };
  }

  const caption = parsePhotoCaption(ctx.body);
  const job = await resolveJobForPhoto(deps.jobRepo, ctx.tenantId, {
    technicianId: user.id,
    ...(caption.jobReference ? { jobReference: caption.jobReference } : {}),
  });

  if (!job) {
    await reply(
      deps,
      ctx,
      "Got your photo — which job is it for? Text the job name (e.g. “Henderson”) and I'll attach it.",
    );
    return { handled: true, attached: 0, reason: 'job_unresolved' };
  }

  const download = deps.downloadMedia ?? downloadTwilioMedia;
  const now = (deps.now ?? (() => new Date()))();
  let attached = 0;

  for (let i = 0; i < ctx.media.length; i++) {
    const item = ctx.media[i];
    const result = await download(item.url, ctx.accountSid, ctx.authToken, item.contentType);
    if (!result.ok) {
      logger.info('sms-job-photo: skipped a media item', { reason: result.reason });
      continue;
    }
    try {
      const ext = EXT_BY_TYPE[result.media.contentType] ?? 'jpg';
      const record = await storeFileBytes(
        {
          tenantId: ctx.tenantId,
          filename: `mms-${ctx.messageSid}-${i}.${ext}`,
          buffer: result.media.buffer,
          contentType: result.media.contentType,
          uploadedBy: user.id,
          entityType: 'job',
          entityId: job.id,
        },
        { fileRepo: deps.fileRepo, storage: deps.storage, bucket: deps.bucket },
      );
      const photo = await deps.jobPhotoRepo.create({
        tenantId: ctx.tenantId,
        jobId: job.id,
        uploadedByUserId: user.id,
        fileId: record.id,
        category: caption.category,
        takenAt: now,
      });
      attached += 1;
      if (deps.auditRepo) {
        await deps.auditRepo
          .create(
            createAuditEvent({
              tenantId: ctx.tenantId,
              actorId: user.id,
              actorRole: user.role,
              eventType: 'job_photo.attached',
              entityType: 'job_photo',
              entityId: photo.id,
              metadata: { jobId: job.id, fileId: record.id, category: caption.category },
            }),
          )
          .catch(() => {});
      }
    } catch (err) {
      logger.warn('sms-job-photo: failed to store/attach a photo', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (attached === 0) {
    await reply(deps, ctx, "Sorry, I couldn't process that photo. Please try sending it again.");
    return { handled: true, attached: 0, reason: 'no_photos_stored' };
  }

  const noun = attached === 1 ? 'photo' : 'photos';
  await reply(deps, ctx, `✓ Saved ${attached} ${noun} to the ${job.summary} job (${caption.category}).`);
  return { handled: true, attached, reason: 'attached' };
}

/** Bind the ingest deps into the webhook's `(ctx) => MmsIngestResult` hook. */
export function buildJobPhotoIngest(
  deps: JobPhotoIngestDeps,
): (ctx: InboundMmsContext) => Promise<MmsIngestResult> {
  return (ctx) => handleInboundMmsPhotos(ctx, deps);
}
