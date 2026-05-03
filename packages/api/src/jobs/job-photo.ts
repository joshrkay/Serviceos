/**
 * P12-001 — Job photos domain model.
 *
 * A `JobPhoto` is a join row that attaches a row in the existing
 * `files` table to a job, plus photo-specific metadata (category,
 * notes, taken_at, uploader). The S3 object + file row continue to
 * be created by the existing `files` pipeline; this module only
 * tracks the per-job overlay so the gallery can render categorized
 * before/after photos for a single job.
 */
import { v4 as uuidv4 } from 'uuid';

export const JOB_PHOTO_CATEGORIES = ['before', 'after', 'problem', 'completion', 'other'] as const;
export type JobPhotoCategory = (typeof JOB_PHOTO_CATEGORIES)[number];

export interface JobPhoto {
  id: string;
  tenantId: string;
  jobId: string;
  uploadedByUserId: string;
  fileId: string;
  category: JobPhotoCategory;
  notes?: string;
  takenAt?: Date;
  createdAt: Date;
}

export interface CreateJobPhotoInput {
  tenantId: string;
  jobId: string;
  uploadedByUserId: string;
  fileId: string;
  category: JobPhotoCategory;
  notes?: string;
  takenAt?: Date;
}

export interface JobPhotoRepository {
  create(input: CreateJobPhotoInput): Promise<JobPhoto>;
  findById(tenantId: string, id: string): Promise<JobPhoto | null>;
  listByJob(tenantId: string, jobId: string): Promise<JobPhoto[]>;
  delete(tenantId: string, id: string): Promise<boolean>;
}

export function isValidJobPhotoCategory(value: unknown): value is JobPhotoCategory {
  return typeof value === 'string' && (JOB_PHOTO_CATEGORIES as readonly string[]).includes(value);
}

export function buildJobPhoto(input: CreateJobPhotoInput): JobPhoto {
  return {
    id: uuidv4(),
    tenantId: input.tenantId,
    jobId: input.jobId,
    uploadedByUserId: input.uploadedByUserId,
    fileId: input.fileId,
    category: input.category,
    notes: input.notes,
    takenAt: input.takenAt,
    createdAt: new Date(),
  };
}

export class InMemoryJobPhotoRepository implements JobPhotoRepository {
  private readonly photos = new Map<string, JobPhoto>();

  async create(input: CreateJobPhotoInput): Promise<JobPhoto> {
    const photo = buildJobPhoto(input);
    this.photos.set(photo.id, { ...photo });
    return { ...photo };
  }

  async findById(tenantId: string, id: string): Promise<JobPhoto | null> {
    const photo = this.photos.get(id);
    if (!photo || photo.tenantId !== tenantId) return null;
    return { ...photo };
  }

  async listByJob(tenantId: string, jobId: string): Promise<JobPhoto[]> {
    return Array.from(this.photos.values())
      .filter((p) => p.tenantId === tenantId && p.jobId === jobId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((p) => ({ ...p }));
  }

  async delete(tenantId: string, id: string): Promise<boolean> {
    const photo = this.photos.get(id);
    if (!photo || photo.tenantId !== tenantId) return false;
    this.photos.delete(id);
    return true;
  }
}
