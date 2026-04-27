import { v4 as uuidv4 } from 'uuid';

export interface JobFile {
  id: string;
  tenantId: string;
  jobId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  storageBucket: string;
  storageKey: string;
  uploadedBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateJobFileInput {
  tenantId: string;
  jobId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  storageBucket: string;
  uploadedBy: string;
}

export interface JobFileRepository {
  create(input: CreateJobFileInput): Promise<JobFile>;
  findById(tenantId: string, id: string): Promise<JobFile | null>;
  listByJob(tenantId: string, jobId: string): Promise<JobFile[]>;
  delete(tenantId: string, id: string): Promise<boolean>;
}

function sanitizeFilename(filename: string): string {
  return filename
    .replace(/\0/g, '')
    .replace(/\.\./g, '')
    .replace(/[/\\]/g, '')
    .trim();
}

export function createJobFileRecord(input: CreateJobFileInput): JobFile {
  const id = uuidv4();
  const safeName = sanitizeFilename(input.filename);
  const storageKey = `${input.tenantId}/jobs/${input.jobId}/${id}/${safeName}`;
  const now = new Date();

  return {
    id,
    tenantId: input.tenantId,
    jobId: input.jobId,
    filename: input.filename,
    contentType: input.contentType,
    sizeBytes: input.sizeBytes,
    storageBucket: input.storageBucket,
    storageKey,
    uploadedBy: input.uploadedBy,
    createdAt: now,
    updatedAt: now,
  };
}

export class InMemoryJobFileRepository implements JobFileRepository {
  private readonly files = new Map<string, JobFile>();

  async create(input: CreateJobFileInput): Promise<JobFile> {
    const record = createJobFileRecord(input);
    this.files.set(record.id, record);
    return { ...record };
  }

  async findById(tenantId: string, id: string): Promise<JobFile | null> {
    const record = this.files.get(id);
    if (!record || record.tenantId !== tenantId) {
      return null;
    }
    return { ...record };
  }

  async listByJob(tenantId: string, jobId: string): Promise<JobFile[]> {
    return Array.from(this.files.values())
      .filter((file) => file.tenantId === tenantId && file.jobId === jobId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((file) => ({ ...file }));
  }

  async delete(tenantId: string, id: string): Promise<boolean> {
    const record = this.files.get(id);
    if (!record || record.tenantId !== tenantId) {
      return false;
    }
    this.files.delete(id);
    return true;
  }
}
