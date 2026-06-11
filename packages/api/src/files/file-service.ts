import { v4 as uuidv4 } from 'uuid';

export interface FileRecord {
  id: string;
  tenantId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  storageBucket: string;
  storageKey: string;
  entityType?: string;
  entityId?: string;
  uploadedBy: string;
  // RV-006: image post-process pipeline outputs. Unset until the
  // image-post-process worker has run for this file. `contentHash` is the
  // SHA-256 hex of the FINAL stored object and is stamped by every pipeline
  // path (success, document hash-only, graceful degradation) — its presence
  // is the worker's "already processed" idempotency marker.
  width?: number;
  height?: number;
  thumbnailS3Key?: string;
  exifStripped?: boolean;
  contentHash?: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * RV-006: partial update applied by the image post-process worker once the
 * pipeline finishes. `contentHash` is required because every pipeline
 * outcome stamps it; the remaining fields are only set on full image
 * success. `contentType`/`sizeBytes` change when HEIC/WEBP is converted to
 * JPEG in place.
 */
export interface FilePipelineUpdate {
  contentHash: string;
  width?: number;
  height?: number;
  thumbnailS3Key?: string;
  exifStripped?: boolean;
  contentType?: string;
  sizeBytes?: number;
}

export interface UploadRequest {
  tenantId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  entityType?: string;
  entityId?: string;
  uploadedBy: string;
}

export interface UploadResult {
  fileRecord: FileRecord;
  uploadUrl: string;
}

export interface FileRepository {
  create(record: FileRecord): Promise<FileRecord>;
  findById(tenantId: string, id: string): Promise<FileRecord | null>;
  findByEntity(tenantId: string, entityType: string, entityId: string): Promise<FileRecord[]>;
  updateSize(tenantId: string, id: string, sizeBytes: number): Promise<FileRecord | null>;
  /** RV-006: stamp post-process pipeline outputs. Null when not found in tenant. */
  updatePipelineResults(
    tenantId: string,
    id: string,
    update: FilePipelineUpdate
  ): Promise<FileRecord | null>;
  /**
   * RV-006: all files in the tenant whose pipeline-computed content_hash
   * matches (newest first). Powers the attach-time dedupe lookup.
   */
  findByContentHash(tenantId: string, contentHash: string): Promise<FileRecord[]>;
  delete(tenantId: string, id: string): Promise<boolean>;
}

export interface ObjectMetadata {
  contentLength: number;
  contentType: string;
}

// StorageProvider abstracts object storage. The production implementation
// targets Cloudflare R2, which is S3-compatible — see S3StorageProvider.
// getObjectMetadata returns null when the backend cannot introspect the
// object (e.g. the dev provider discards bytes); callers must treat null
// as "skip reconciliation". Likewise getObject returns null when the
// object's bytes are unavailable (missing key, or the dev provider which
// discards payloads); callers must treat null as "skip processing".
export interface StorageProvider {
  generateUploadUrl(bucket: string, key: string, contentType: string): Promise<string>;
  generateDownloadUrl(bucket: string, key: string): Promise<string>;
  getObjectMetadata(bucket: string, key: string): Promise<ObjectMetadata | null>;
  /** RV-006: fetch the full object body. Null when unavailable. */
  getObject(bucket: string, key: string): Promise<Buffer | null>;
  /** RV-006: write/overwrite an object server-side (post-process outputs). */
  putObject(bucket: string, key: string, body: Buffer, contentType: string): Promise<void>;
  deleteObject(bucket: string, key: string): Promise<void>;
}

export const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB
const ALLOWED_CONTENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'application/pdf',
  'audio/mpeg',
  'audio/wav',
  'audio/ogg',
  'audio/webm',
  'text/plain',
  'application/json',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
];

export function sanitizeFilename(filename: string): string {
  // Remove path separators, parent directory references, and null bytes
  return filename
    .replace(/\0/g, '')
    .replace(/\.\./g, '')
    .replace(/[/\\]/g, '')
    .trim();
}

/**
 * Normalize a Content-Type header into its base type (strip codec
 * params). Browsers' MediaRecorder emits values like
 * `audio/webm;codecs=opus` per RFC 2045; the whitelist below keys on
 * the base type only. Normalizing here means the web client doesn't
 * have to remember to strip params before every upload.
 */
export function normalizeContentType(contentType: string): string {
  return contentType.split(';')[0].trim().toLowerCase();
}

export function validateUpload(request: UploadRequest): string[] {
  const errors: string[] = [];
  if (!request.filename || request.filename.trim().length === 0) {
    errors.push('Filename is required');
  } else {
    const sanitized = sanitizeFilename(request.filename);
    if (sanitized.length === 0) {
      errors.push('Filename contains only invalid characters');
    }
    if (sanitized !== request.filename) {
      errors.push('Filename contains invalid characters (path separators or ".." not allowed)');
    }
  }
  if (!request.contentType) {
    errors.push('Content type is required');
  } else if (!ALLOWED_CONTENT_TYPES.includes(normalizeContentType(request.contentType))) {
    errors.push(`Content type not allowed: ${request.contentType}`);
  }
  if (!request.sizeBytes || request.sizeBytes <= 0) {
    errors.push('File size must be positive');
  } else if (request.sizeBytes > MAX_FILE_SIZE) {
    errors.push(`File size exceeds maximum of ${MAX_FILE_SIZE} bytes`);
  }
  if (!request.tenantId) {
    errors.push('Tenant ID is required');
  }
  if (!request.uploadedBy) {
    errors.push('Uploader ID is required');
  }
  return errors;
}

export function createFileRecord(request: UploadRequest, bucket: string): FileRecord {
  const id = uuidv4();
  const safeName = sanitizeFilename(request.filename);
  const key = `${request.tenantId}/${id}/${safeName}`;
  return {
    id,
    tenantId: request.tenantId,
    filename: request.filename,
    contentType: request.contentType,
    sizeBytes: request.sizeBytes,
    storageBucket: bucket,
    storageKey: key,
    entityType: request.entityType,
    entityId: request.entityId,
    uploadedBy: request.uploadedBy,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

export class InMemoryFileRepository implements FileRepository {
  private files: Map<string, FileRecord> = new Map();

  async create(record: FileRecord): Promise<FileRecord> {
    this.files.set(record.id, { ...record });
    return record;
  }

  async findById(tenantId: string, id: string): Promise<FileRecord | null> {
    const file = this.files.get(id);
    if (!file || file.tenantId !== tenantId) return null;
    return { ...file };
  }

  async findByEntity(tenantId: string, entityType: string, entityId: string): Promise<FileRecord[]> {
    return Array.from(this.files.values()).filter(
      (f) => f.tenantId === tenantId && f.entityType === entityType && f.entityId === entityId
    );
  }

  async updateSize(tenantId: string, id: string, sizeBytes: number): Promise<FileRecord | null> {
    const file = this.files.get(id);
    if (!file || file.tenantId !== tenantId) return null;
    const updated: FileRecord = { ...file, sizeBytes, updatedAt: new Date() };
    this.files.set(id, updated);
    return { ...updated };
  }

  async updatePipelineResults(
    tenantId: string,
    id: string,
    update: FilePipelineUpdate
  ): Promise<FileRecord | null> {
    const file = this.files.get(id);
    if (!file || file.tenantId !== tenantId) return null;
    const updated: FileRecord = {
      ...file,
      contentHash: update.contentHash,
      width: update.width ?? file.width,
      height: update.height ?? file.height,
      thumbnailS3Key: update.thumbnailS3Key ?? file.thumbnailS3Key,
      exifStripped: update.exifStripped ?? file.exifStripped ?? false,
      contentType: update.contentType ?? file.contentType,
      sizeBytes: update.sizeBytes ?? file.sizeBytes,
      updatedAt: new Date(),
    };
    this.files.set(id, updated);
    return { ...updated };
  }

  async findByContentHash(tenantId: string, contentHash: string): Promise<FileRecord[]> {
    return Array.from(this.files.values())
      .filter((f) => f.tenantId === tenantId && f.contentHash === contentHash)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((f) => ({ ...f }));
  }

  async delete(tenantId: string, id: string): Promise<boolean> {
    const file = this.files.get(id);
    if (!file || file.tenantId !== tenantId) return false;
    this.files.delete(id);
    return true;
  }
}
