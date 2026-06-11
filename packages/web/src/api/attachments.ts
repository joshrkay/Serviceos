/**
 * RV-020 — Web client for the generalized attachments API.
 *
 * Uploads use the same 3-step pattern as job photos:
 *   1. POST /api/attachments/presign  -> { uploadUrl, fileId }
 *   2. PUT to uploadUrl with raw bytes
 *   3. POST /api/attachments          -> Attachment row
 */
import { apiFetch } from '../utils/api-fetch';

export type AttachmentEntityType = 'job' | 'invoice' | 'estimate';
export type AttachmentCategory =
  | 'before'
  | 'after'
  | 'problem'
  | 'completion'
  | 'receipt'
  | 'other';
export type AttachmentKind = 'photo' | 'document';
export type AttachmentSource = 'app' | 'voice' | 'portal' | 'sms';

export const ATTACHMENT_CATEGORIES: ReadonlyArray<AttachmentCategory> = [
  'before',
  'after',
  'problem',
  'completion',
  'receipt',
  'other',
];

export interface Attachment {
  id: string;
  tenantId?: string;
  fileId: string;
  entityType: AttachmentEntityType;
  entityId: string;
  kind: AttachmentKind;
  caption?: string;
  category?: AttachmentCategory;
  portalVisible?: boolean;
  source?: AttachmentSource;
  sortOrder?: number;
  archivedAt?: string;
  createdAt?: string;
  updatedAt?: string;
  downloadUrl?: string;
  filename?: string;
  contentType?: string;
  sizeBytes?: number;
}

export interface PresignAttachmentResponse {
  fileId: string;
  uploadUrl: string;
  fileRecord?: { id: string; storageBucket: string; storageKey: string };
}

export async function presignAttachmentUpload(payload: {
  entityType: AttachmentEntityType;
  entityId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
}): Promise<PresignAttachmentResponse> {
  const res = await apiFetch('/api/attachments/presign', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Presign failed: ${res.status}`);
  return (await res.json()) as PresignAttachmentResponse;
}

export async function attachFileToEntity(payload: {
  fileId: string;
  entityType: AttachmentEntityType;
  entityId: string;
  kind: AttachmentKind;
  caption?: string;
  category?: AttachmentCategory;
  source?: AttachmentSource;
}): Promise<Attachment> {
  const res = await apiFetch('/api/attachments', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Attach failed: ${res.status}`);
  return (await res.json()) as Attachment;
}

export async function listAttachments(
  entityType: AttachmentEntityType,
  entityId: string,
): Promise<Attachment[]> {
  const params = new URLSearchParams({ entityType, entityId });
  const res = await apiFetch(`/api/attachments?${params.toString()}`);
  if (!res.ok) throw new Error(`List failed: ${res.status}`);
  return (await res.json()) as Attachment[];
}

export async function uploadAttachment(
  entityType: AttachmentEntityType,
  entityId: string,
  file: File,
  category: AttachmentCategory,
  caption?: string,
  source: AttachmentSource = 'app',
): Promise<Attachment> {
  const contentType = file.type || 'application/octet-stream';
  const presign = await presignAttachmentUpload({
    entityType,
    entityId,
    filename: file.name,
    contentType,
    sizeBytes: file.size,
  });
  // Uses the global fetch (NOT apiFetch) for the S3 PUT because the
  // presigned URL already contains its own auth and adding a Bearer
  // token would invalidate the signature.
  const put = await fetch(presign.uploadUrl, {
    method: 'PUT',
    body: file,
    headers: { 'Content-Type': contentType },
  });
  if (!put.ok) throw new Error(`S3 PUT failed: ${put.status}`);
  return attachFileToEntity({
    fileId: presign.fileId,
    entityType,
    entityId,
    kind: 'photo',
    caption: caption?.trim() || undefined,
    category,
    source,
  });
}
