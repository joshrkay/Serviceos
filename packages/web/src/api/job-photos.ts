/**
 * P12-001 — Web client for the job-photos API.
 *
 * Two-step upload mirrors the server contract:
 *   1. POST /api/jobs/:id/photos/presign-upload  → { uploadUrl, fileId }
 *   2. PUT to uploadUrl with the raw file bytes
 *   3. POST /api/jobs/:id/photos                 → JobPhoto join row
 */
import { apiFetch } from '../utils/api-fetch';

export type JobPhotoCategory = 'before' | 'after' | 'problem' | 'completion' | 'other';

export const JOB_PHOTO_CATEGORIES: ReadonlyArray<JobPhotoCategory> = [
  'before',
  'after',
  'problem',
  'completion',
  'other',
];

export interface JobPhoto {
  id: string;
  tenantId: string;
  jobId: string;
  uploadedByUserId: string;
  fileId: string;
  category: JobPhotoCategory;
  notes?: string;
  takenAt?: string;
  clientVisible?: boolean;
  createdAt: string;
  downloadUrl: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
}

export interface PresignResponse {
  fileId: string;
  uploadUrl: string;
  fileRecord: { id: string; storageBucket: string; storageKey: string };
}

export async function presignJobPhotoUpload(
  jobId: string,
  payload: { filename: string; contentType: string; sizeBytes: number }
): Promise<PresignResponse> {
  const res = await apiFetch(
    `/api/jobs/${encodeURIComponent(jobId)}/photos/presign-upload`,
    { method: 'POST', body: JSON.stringify(payload) }
  );
  if (!res.ok) throw new Error(`Presign failed: ${res.status}`);
  return (await res.json()) as PresignResponse;
}

export async function attachJobPhoto(
  jobId: string,
  payload: {
    fileId: string;
    category: JobPhotoCategory;
    notes?: string;
    takenAt?: string;
  }
): Promise<JobPhoto> {
  const res = await apiFetch(`/api/jobs/${encodeURIComponent(jobId)}/photos`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Attach failed: ${res.status}`);
  return (await res.json()) as JobPhoto;
}

export async function listJobPhotos(jobId: string): Promise<JobPhoto[]> {
  const res = await apiFetch(`/api/jobs/${encodeURIComponent(jobId)}/photos`);
  if (!res.ok) throw new Error(`List failed: ${res.status}`);
  return (await res.json()) as JobPhoto[];
}

export async function setJobPhotoClientVisible(
  jobId: string,
  photoId: string,
  clientVisible: boolean,
): Promise<JobPhoto> {
  const res = await apiFetch(
    `/api/jobs/${encodeURIComponent(jobId)}/photos/${encodeURIComponent(photoId)}`,
    { method: 'PATCH', body: JSON.stringify({ clientVisible }) },
  );
  if (!res.ok) throw new Error(`Update failed: ${res.status}`);
  return (await res.json()) as JobPhoto;
}

export async function deleteJobPhoto(jobId: string, photoId: string): Promise<void> {
  const res = await apiFetch(
    `/api/jobs/${encodeURIComponent(jobId)}/photos/${encodeURIComponent(photoId)}`,
    { method: 'DELETE' }
  );
  if (!res.ok && res.status !== 204) throw new Error(`Delete failed: ${res.status}`);
}

/**
 * Convenience: orchestrate presign → S3 PUT → attach in one call.
 * Uses the global fetch (NOT apiFetch) for the S3 PUT because the
 * presigned URL already contains its own auth and adding a Bearer
 * token would invalidate the signature.
 */
export async function uploadJobPhoto(
  jobId: string,
  file: File,
  category: JobPhotoCategory,
  notes?: string,
  takenAt?: string
): Promise<JobPhoto> {
  const presign = await presignJobPhotoUpload(jobId, {
    filename: file.name,
    contentType: file.type || 'application/octet-stream',
    sizeBytes: file.size,
  });
  const put = await fetch(presign.uploadUrl, {
    method: 'PUT',
    body: file,
    headers: { 'Content-Type': file.type || 'application/octet-stream' },
  });
  if (!put.ok) throw new Error(`S3 PUT failed: ${put.status}`);
  return attachJobPhoto(jobId, {
    fileId: presign.fileId,
    category,
    notes,
    takenAt,
  });
}
