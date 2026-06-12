import { v4 as uuidv4 } from 'uuid';

export interface ChecklistItem {
  id: string;
  label: string;
  required: boolean;
  completed: boolean;
  note?: string;
}

export interface JobChecklist {
  id: string;
  tenantId: string;
  jobId: string;
  title: string;
  items: ChecklistItem[];
  completedAt?: Date;
  createdAt: Date;
}

export interface CreateJobChecklistInput {
  tenantId: string;
  jobId: string;
  title: string;
  items: ChecklistItem[];
}

export interface JobChecklistRepository {
  create(input: CreateJobChecklistInput): Promise<JobChecklist>;
  findById(tenantId: string, id: string): Promise<JobChecklist | null>;
  listByJob(tenantId: string, jobId: string): Promise<JobChecklist[]>;
  updateItems(tenantId: string, id: string, items: ChecklistItem[]): Promise<JobChecklist | null>;
  markComplete(tenantId: string, id: string): Promise<JobChecklist | null>;
}

export function buildJobChecklist(input: CreateJobChecklistInput): JobChecklist {
  return {
    id: uuidv4(),
    tenantId: input.tenantId,
    jobId: input.jobId,
    title: input.title,
    items: input.items,
    createdAt: new Date(),
  };
}

export class InMemoryJobChecklistRepository implements JobChecklistRepository {
  private readonly rows = new Map<string, JobChecklist>();

  async create(input: CreateJobChecklistInput): Promise<JobChecklist> {
    const row = buildJobChecklist(input);
    this.rows.set(row.id, { ...row, items: [...row.items] });
    return { ...row, items: [...row.items] };
  }

  async findById(tenantId: string, id: string): Promise<JobChecklist | null> {
    const row = this.rows.get(id);
    if (!row || row.tenantId !== tenantId) return null;
    return { ...row, items: [...row.items] };
  }

  async listByJob(tenantId: string, jobId: string): Promise<JobChecklist[]> {
    return Array.from(this.rows.values())
      .filter((r) => r.tenantId === tenantId && r.jobId === jobId)
      .map((r) => ({ ...r, items: [...r.items] }));
  }

  async updateItems(tenantId: string, id: string, items: ChecklistItem[]): Promise<JobChecklist | null> {
    const row = this.rows.get(id);
    if (!row || row.tenantId !== tenantId) return null;
    const updated = { ...row, items: [...items] };
    this.rows.set(id, updated);
    return { ...updated };
  }

  async markComplete(tenantId: string, id: string): Promise<JobChecklist | null> {
    const row = this.rows.get(id);
    if (!row || row.tenantId !== tenantId) return null;
    const updated = { ...row, completedAt: new Date() };
    this.rows.set(id, updated);
    return { ...updated };
  }
}
