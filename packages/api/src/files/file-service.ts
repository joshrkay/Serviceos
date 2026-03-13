import { v4 as uuidv4 } from 'uuid';

export interface FileRecord {
  id: string;
  tenantId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  s3Bucket: string;
  s3Key: string;
  entityType?: string;
  entityId?: string;
  uploadedBy: string;
  createdAt: Date;
  updatedAt: Date;
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
  delete(tenantId: string, id: string): Promise<boolean>;
}

export interface StorageProvider {
  generateUploadUrl(bucket: string, key: string, contentType: string): Promise<string>;
  generateDownloadUrl(bucket: string, key: string): Promise<string>;
  deleteObject(bucket: string, key: string): Promise<void>;
}

const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB
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

export function validateUpload(request: UploadRequest): string[] {
  const errors: string[] = [];
  if (!request.filename || request.filename.trim().length === 0) {
    errors.push('Filename is required');
  }
  if (!request.contentType) {
    errors.push('Content type is required');
  } else if (!ALLOWED_CONTENT_TYPES.includes(request.contentType)) {
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
  const key = `${request.tenantId}/${id}/${request.filename}`;
  return {
    id,
    tenantId: request.tenantId,
    filename: request.filename,
    contentType: request.contentType,
    sizeBytes: request.sizeBytes,
    s3Bucket: bucket,
    s3Key: key,
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

  async delete(tenantId: string, id: string): Promise<boolean> {
    const file = this.files.get(id);
    if (!file || file.tenantId !== tenantId) return false;
    this.files.delete(id);
    return true;
  }
}
