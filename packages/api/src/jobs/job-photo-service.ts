/**
 * P12-001 — Job photo service.
 *
 * Thin orchestration over the JobPhotoRepository + the existing files
 * pipeline (FileRepository + StorageProvider). The route layer handles
 * presigning + validation; this service centralises tenant-scoped CRUD
 * and the cross-table lookup that returns photos joined with their
 * underlying file's download URL.
 */
import {
  CreateJobPhotoInput,
  JobPhoto,
  JobPhotoCategory,
  JobPhotoRepository,
  isValidJobPhotoCategory,
} from './job-photo';
import {
  ATTACHMENT_CATEGORIES,
  AttachmentCategory,
  AttachmentRepository,
} from '../attachments/attachment';
import { FileRepository, StorageProvider } from '../files/file-service';
import { ValidationError, NotFoundError } from '../shared/errors';
import { Queue } from '../queues/queue';
import {
  IMAGE_POST_PROCESS_TYPE,
  imagePostProcessIdempotencyKey,
} from '../workers/image-post-process-worker';

/**
 * RV-005 — map a job-photo category onto the attachments category enum.
 * The job-photo values (before/after/problem/completion/other) all exist in
 * ATTACHMENT_CATEGORIES today; the guard keeps the shadow write safe if the
 * job-photo enum ever grows a value attachments doesn't know about.
 */
export function mapJobPhotoCategoryToAttachmentCategory(
  category: JobPhotoCategory
): AttachmentCategory {
  return (ATTACHMENT_CATEGORIES as readonly string[]).includes(category)
    ? (category as AttachmentCategory)
    : 'other';
}

export interface JobPhotoWithUrl extends JobPhoto {
  downloadUrl: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
}

export class JobPhotoService {
  constructor(
    private readonly repo: JobPhotoRepository,
    private readonly fileRepo: FileRepository,
    private readonly storage: StorageProvider,
    // RV-005: optional dual-write shadow into the generalized `attachments`
    // table. When absent (existing call sites / tests that don't pass it),
    // behavior is exactly as before. `job_photos` remains the system of
    // record for this flow; the shadow row lets new attachment surfaces
    // see job photos without a backfill.
    private readonly attachmentRepo?: AttachmentRepository,
    // RV-006: optional queue for the image post-process pipeline. The
    // job-photo flow does NOT go through AttachmentService.attach (it
    // writes the shadow attachment row directly), so it needs its own
    // enqueue hook. Same optional-dependency + failure-isolation pattern
    // as the dual-write above.
    private readonly queue?: Pick<Queue, 'send'>
  ) {}

  async attachPhotoToJob(
    tenantId: string,
    jobId: string,
    fileId: string,
    category: JobPhotoCategory,
    notes: string | undefined,
    takenAt: Date | undefined,
    uploadedByUserId: string
  ): Promise<JobPhoto> {
    if (!tenantId) throw new ValidationError('tenantId is required');
    if (!jobId) throw new ValidationError('jobId is required');
    if (!fileId) throw new ValidationError('fileId is required');
    if (!uploadedByUserId) throw new ValidationError('uploadedByUserId is required');
    if (!isValidJobPhotoCategory(category)) {
      throw new ValidationError(`Invalid category: ${String(category)}`);
    }

    // Confirm the file row exists in this tenant before linking. The
    // FK in Postgres would fail anyway, but resolving here gives a
    // 400 instead of a 500 and keeps in-memory tests honest.
    const file = await this.fileRepo.findById(tenantId, fileId);
    if (!file) throw new NotFoundError('File', fileId);

    const input: CreateJobPhotoInput = {
      tenantId,
      jobId,
      uploadedByUserId,
      fileId,
      category,
      notes,
      takenAt,
    };
    const photo = await this.repo.create(input);

    if (this.attachmentRepo) {
      // Best-effort shadow write: a failure here must not break the
      // existing job-photo flow (job_photos is still the system of record).
      try {
        await this.attachmentRepo.create(tenantId, {
          fileId,
          entityType: 'job',
          entityId: jobId,
          kind: 'photo',
          caption: notes,
          category: mapJobPhotoCategoryToAttachmentCategory(category),
          uploadedBy: uploadedByUserId,
          source: 'app',
        });
      } catch (err) {
        console.error(
          `RV-005 attachments shadow write failed for job photo ${photo.id}:`,
          err
        );
      }
    }

    // RV-006: kick the image post-process pipeline. Failure-isolated — the
    // photo attach must never fail because the queue is down; the worker's
    // content_hash idempotency marker also makes duplicate enqueues safe.
    if (this.queue) {
      try {
        await this.queue.send(
          IMAGE_POST_PROCESS_TYPE,
          { tenantId, fileId },
          imagePostProcessIdempotencyKey(fileId)
        );
      } catch (err) {
        console.error(
          `RV-006 image post-process enqueue failed for file ${fileId}:`,
          err
        );
      }
    }

    return photo;
  }

  async listJobPhotos(tenantId: string, jobId: string): Promise<JobPhotoWithUrl[]> {
    const photos = await this.repo.listByJob(tenantId, jobId);
    return Promise.all(
      photos.map(async (photo) => {
        const file = await this.fileRepo.findById(tenantId, photo.fileId);
        if (!file) {
          // File was deleted out from under us — surface a placeholder
          // entry so the gallery can still show metadata + offer to
          // delete the orphaned join row.
          return {
            ...photo,
            downloadUrl: '',
            filename: '',
            contentType: '',
            sizeBytes: 0,
          };
        }
        const downloadUrl = await this.storage.generateDownloadUrl(
          file.storageBucket,
          file.storageKey
        );
        return {
          ...photo,
          downloadUrl,
          filename: file.filename,
          contentType: file.contentType,
          sizeBytes: file.sizeBytes,
        };
      })
    );
  }

  async deleteJobPhoto(tenantId: string, jobId: string, photoId: string): Promise<boolean> {
    const photo = await this.repo.findById(tenantId, photoId);
    if (!photo || photo.jobId !== jobId) return false;
    const deleted = await this.repo.delete(tenantId, photoId);

    // RV-005 dual-write: archive the shadow attachment row when deleting a
    // job photo. Best-effort — a failure here must not break the delete.
    if (deleted && this.attachmentRepo) {
      try {
        const shadow = await this.attachmentRepo.findByFileId(
          tenantId,
          photo.fileId,
          'job',
          jobId
        );
        if (shadow) {
          await this.attachmentRepo.archive(tenantId, shadow.id);
        }
      } catch (err) {
        console.error(
          `RV-005 attachments shadow archive failed for job photo ${photoId}:`,
          err
        );
      }
    }

    return deleted;
  }
}
