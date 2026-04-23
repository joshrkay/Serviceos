import { FileRecord } from './file-service';

export interface JobFileRecord extends FileRecord {
  entityType: 'job';
  entityId: string;
}

export interface JobFileRepository {
  create(record: JobFileRecord): Promise<JobFileRecord>;
  findById(tenantId: string, id: string): Promise<JobFileRecord | null>;
  findByJob(tenantId: string, jobId: string): Promise<JobFileRecord[]>;
  updateSize(tenantId: string, id: string, sizeBytes: number): Promise<JobFileRecord | null>;
  delete(tenantId: string, id: string): Promise<boolean>;
}

export class InMemoryJobFileRepository implements JobFileRepository {
  private readonly files = new Map<string, JobFileRecord>();

  async create(record: JobFileRecord): Promise<JobFileRecord> {
    this.files.set(record.id, { ...record });
    return { ...record };
  }

  async findById(tenantId: string, id: string): Promise<JobFileRecord | null> {
    const file = this.files.get(id);
    if (!file || file.tenantId !== tenantId) return null;
    return { ...file };
  }

  async findByJob(tenantId: string, jobId: string): Promise<JobFileRecord[]> {
    return Array.from(this.files.values())
      .filter((file) => file.tenantId === tenantId && file.entityType === 'job' && file.entityId === jobId)
      .map((file) => ({ ...file }));
  }

  async updateSize(tenantId: string, id: string, sizeBytes: number): Promise<JobFileRecord | null> {
    const file = this.files.get(id);
    if (!file || file.tenantId !== tenantId) return null;
    const updated: JobFileRecord = {
      ...file,
      sizeBytes,
      updatedAt: new Date(),
    };
    this.files.set(id, updated);
    return { ...updated };
  }

  async delete(tenantId: string, id: string): Promise<boolean> {
    const file = this.files.get(id);
    if (!file || file.tenantId !== tenantId) return false;
    this.files.delete(id);
    return true;
  }
}
