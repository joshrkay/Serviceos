/**
 * U9 (E6) — Mobile job-photo upload pipeline.
 *
 * Mirrors the voice signed-upload precedent (`src/voice/uploadAndTranscribe.ts`):
 * a pure, RN-free, DI-driven module so it unit-tests with a mocked `api`/uploader
 * and never touches the filesystem or expo-camera. The native wiring lives in
 * `src/jobs/nativeJobPhotoDeps.ts`.
 *
 * Two-step server contract (`packages/api/src/routes/job-photos.ts`):
 *   1. POST /api/jobs/:id/photos/presign-upload → { fileId, uploadUrl }
 *   2. PUT the raw bytes to uploadUrl
 *   3. POST /api/jobs/:id/photos                → JobPhoto join row
 * Tenant scoping, the audit event, and the 10MB / image-type caps are all
 * enforced server-side; the client never trusts itself.
 */
import type { ApiFetch } from '../lib/apiFetch';

export type JobPhotoCategory = 'before' | 'after' | 'problem' | 'completion' | 'other';

export interface JobPhoto {
  id: string;
  tenantId: string;
  jobId: string;
  uploadedByUserId: string;
  fileId: string;
  category: JobPhotoCategory;
  notes?: string;
  takenAt?: string;
  createdAt: string;
  downloadUrl: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
}

/** A captured photo: a local file URI + metadata. */
export interface CapturedPhoto {
  fileUri: string;
  /** Base MIME type, e.g. 'image/jpeg'. Must be API-whitelisted. */
  contentType: string;
  sizeBytes: number;
}

/** PUTs the local file to the signed URL. Injected so tests never touch the FS. */
export type FileUploader = (
  uploadUrl: string,
  fileUri: string,
  contentType: string,
) => Promise<{ ok: boolean; status: number }>;

export interface UploadJobPhotoDeps {
  api: ApiFetch;
  uploadFile: FileUploader;
  now?: () => number;
}

const EXT_BY_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

/**
 * Run presign → PUT → attach for one captured photo and return the persisted
 * JobPhoto. Throws (never silently succeeds) if any step fails, so the screen
 * surfaces the error instead of faking a saved photo.
 */
export async function uploadJobPhoto(
  jobId: string,
  photo: CapturedPhoto,
  category: JobPhotoCategory,
  deps: UploadJobPhotoDeps,
  opts: { notes?: string; takenAt?: string } = {},
): Promise<JobPhoto> {
  const ext = EXT_BY_TYPE[photo.contentType] ?? 'jpg';
  const ts = (deps.now ?? Date.now)();
  const base = `/api/jobs/${encodeURIComponent(jobId)}/photos`;

  // Step 1 — presign.
  const presignRes = await deps.api(`${base}/presign-upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filename: `job-photo-${ts}.${ext}`,
      contentType: photo.contentType,
      sizeBytes: photo.sizeBytes,
    }),
  });
  if (!presignRes.ok) throw new Error('Unable to get a signed upload URL.');
  const presign = (await presignRes.json()) as { fileId?: string; uploadUrl?: string };
  if (!presign.fileId || !presign.uploadUrl) {
    throw new Error('Upload URL response is missing required fields.');
  }

  // Step 2 — PUT raw bytes to the signed URL.
  const put = await deps.uploadFile(presign.uploadUrl, photo.fileUri, photo.contentType);
  if (!put.ok) throw new Error('Photo upload failed. Please retry.');

  // Step 3 — attach to the job.
  const attachRes = await deps.api(base, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fileId: presign.fileId,
      category,
      notes: opts.notes,
      takenAt: opts.takenAt,
    }),
  });
  if (!attachRes.ok) throw new Error('Could not attach the photo to this job.');
  return (await attachRes.json()) as JobPhoto;
}

/** List persisted photos for a job (used to refresh the gallery after upload). */
export async function listJobPhotos(jobId: string, api: ApiFetch): Promise<JobPhoto[]> {
  const res = await api(`/api/jobs/${encodeURIComponent(jobId)}/photos`);
  if (!res.ok) throw new Error('Failed to load photos.');
  const data = (await res.json()) as JobPhoto[];
  return Array.isArray(data) ? data : [];
}
