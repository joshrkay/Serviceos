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
import { FileRepository, StorageProvider } from '../files/file-service';
import { ValidationError, NotFoundError } from '../shared/errors';

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
    private readonly storage: StorageProvider
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
    return this.repo.create(input);
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
    return this.repo.delete(tenantId, photoId);
  }
}
