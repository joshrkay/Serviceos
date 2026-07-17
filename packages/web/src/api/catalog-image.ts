/**
 * EE-4 — Web client for attaching a photo to a catalog (price-book) item.
 *
 * Reuses the generic P0-010 presigned-upload endpoint (no new storage):
 *   1. POST /api/files/upload-url { entityType: 'catalog_item' } → { fileId, uploadUrl, downloadUrl }
 *   2. PUT the raw bytes to uploadUrl
 * The caller then saves the returned `fileId` onto the catalog item's
 * `imageFileId`. No signed URL is ever persisted — the customer-facing view
 * mints a fresh, tenant-scoped one at read time.
 */
import { apiFetch } from '../utils/api-fetch';

export interface CatalogImageUploadResult {
  fileId: string;
  /** Short-lived GET URL for immediate in-app preview (never persisted). */
  downloadUrl: string;
}

interface UploadUrlResponse {
  fileId: string;
  uploadUrl: string;
  downloadUrl: string;
}

export async function uploadCatalogImage(file: File): Promise<CatalogImageUploadResult> {
  const contentType = file.type || 'application/octet-stream';
  const res = await apiFetch('/api/files/upload-url', {
    method: 'POST',
    body: JSON.stringify({
      filename: file.name,
      contentType,
      sizeBytes: file.size,
      entityType: 'catalog_item',
    }),
  });
  if (!res.ok) throw new Error(`Presign failed: ${res.status}`);
  const presign = (await res.json()) as UploadUrlResponse;

  // Raw fetch (NOT apiFetch): the presigned URL carries its own auth in the
  // query string; adding a Bearer header would invalidate the S3 signature.
  const put = await fetch(presign.uploadUrl, {
    method: 'PUT',
    body: file,
    headers: { 'Content-Type': contentType },
  });
  if (!put.ok) throw new Error(`Upload failed: ${put.status}`);

  return { fileId: presign.fileId, downloadUrl: presign.downloadUrl };
}
