import { v4 as uuidv4 } from 'uuid';

// ─── P5-002A: Core context types ───

export interface JobSummary {
  id: string;
  title: string;
  description?: string;
  status: string;
  completedAt?: Date;
  customerId: string;
}

export interface CustomerSummary {
  id: string;
  name: string;
  email?: string;
  phone?: string;
  address?: string;
}

export interface LocationSummary {
  address: string;
  city?: string;
  state?: string;
  zip?: string;
}

export interface TenantInvoiceSettings {
  defaultTaxRateBps: number;
  invoiceNumberPrefix: string;
  nextInvoiceNumber: number;
  defaultPaymentTermDays: number;
  currency: string;
}

export interface InvoiceContext {
  tenantId: string;
  job: JobSummary;
  customer: CustomerSummary;
  tenantSettings: TenantInvoiceSettings;
}

export interface JobRepository {
  findById(tenantId: string, id: string): Promise<JobSummary | null>;
}

export interface CustomerRepository {
  findById(tenantId: string, id: string): Promise<CustomerSummary | null>;
}

export interface TenantSettingsRepository {
  getInvoiceSettings(tenantId: string): Promise<TenantInvoiceSettings>;
}

export interface InvoiceContextRepositories {
  jobRepo: JobRepository;
  customerRepo: CustomerRepository;
  settingsRepo: TenantSettingsRepository;
}

export function validateInvoiceContextInput(tenantId: string, jobId: string, customerId: string): string[] {
  const errors: string[] = [];
  if (!tenantId) errors.push('tenantId is required');
  if (!jobId) errors.push('jobId is required');
  if (!customerId) errors.push('customerId is required');
  return errors;
}

export async function assembleInvoiceContext(
  tenantId: string,
  jobId: string,
  customerId: string,
  repos: InvoiceContextRepositories
): Promise<InvoiceContext> {
  const errors = validateInvoiceContextInput(tenantId, jobId, customerId);
  if (errors.length > 0) {
    throw new Error(`Invalid input: ${errors.join(', ')}`);
  }

  const job = await repos.jobRepo.findById(tenantId, jobId);
  if (!job) throw new Error(`Job not found: ${jobId}`);

  const customer = await repos.customerRepo.findById(tenantId, customerId);
  if (!customer) throw new Error(`Customer not found: ${customerId}`);

  const tenantSettings = await repos.settingsRepo.getInvoiceSettings(tenantId);

  return { tenantId, job, customer, tenantSettings };
}

// ─── P5-002B: Technician context ───

export interface TechnicianUpdate {
  id: string;
  technicianId: string;
  technicianName: string;
  updateType: string;
  content: string;
  timestamp: Date;
}

export interface ConversationMessage {
  id: string;
  role: string;
  content: string;
  timestamp: Date;
}

export interface TechnicianContext {
  updates: TechnicianUpdate[];
  conversations: ConversationMessage[];
}

export interface TechnicianUpdateRepository {
  findByJob(tenantId: string, jobId: string): Promise<TechnicianUpdate[]>;
}

export interface ConversationRepository {
  findByJob(tenantId: string, jobId: string): Promise<ConversationMessage[]>;
}

export interface TechnicianContextRepositories {
  updateRepo: TechnicianUpdateRepository;
  conversationRepo: ConversationRepository;
}

export function validateTechnicianContextInput(tenantId: string, jobId: string): string[] {
  const errors: string[] = [];
  if (!tenantId) errors.push('tenantId is required');
  if (!jobId) errors.push('jobId is required');
  return errors;
}

export async function assembleTechnicianContext(
  tenantId: string,
  jobId: string,
  repos: TechnicianContextRepositories
): Promise<TechnicianContext> {
  const errors = validateTechnicianContextInput(tenantId, jobId);
  if (errors.length > 0) {
    throw new Error(`Invalid input: ${errors.join(', ')}`);
  }

  const updates = await repos.updateRepo.findByJob(tenantId, jobId);
  const conversations = await repos.conversationRepo.findByJob(tenantId, jobId);

  return { updates, conversations };
}

// ─── P5-002C: Estimate reference ───

export interface EstimateReference {
  estimateId: string;
  estimateNumber: string;
  status: string;
  lineItems: Array<{
    description: string;
    quantity: number;
    unitPriceCents: number;
    totalCents: number;
  }>;
  totalCents: number;
  approvedAt?: Date;
}

export interface EstimateReferenceRepository {
  findApprovedByJob(tenantId: string, jobId: string): Promise<EstimateReference | null>;
}

export async function assembleEstimateReference(
  tenantId: string,
  jobId: string,
  estimateRepo: EstimateReferenceRepository
): Promise<EstimateReference | null> {
  if (!tenantId || !jobId) return null;
  return estimateRepo.findApprovedByJob(tenantId, jobId);
}

// ─── InMemory Repositories for testing ───

export class InMemoryJobRepository implements JobRepository {
  private jobs: Map<string, JobSummary & { tenantId: string }> = new Map();

  addJob(tenantId: string, job: JobSummary): void {
    this.jobs.set(job.id, { ...job, tenantId });
  }

  async findById(tenantId: string, id: string): Promise<JobSummary | null> {
    const job = this.jobs.get(id);
    if (!job || job.tenantId !== tenantId) return null;
    const { tenantId: _, ...rest } = job;
    return rest;
  }
}

export class InMemoryCustomerRepository implements CustomerRepository {
  private customers: Map<string, CustomerSummary & { tenantId: string }> = new Map();

  addCustomer(tenantId: string, customer: CustomerSummary): void {
    this.customers.set(customer.id, { ...customer, tenantId });
  }

  async findById(tenantId: string, id: string): Promise<CustomerSummary | null> {
    const c = this.customers.get(id);
    if (!c || c.tenantId !== tenantId) return null;
    const { tenantId: _, ...rest } = c;
    return rest;
  }
}

export class InMemoryTenantSettingsRepository implements TenantSettingsRepository {
  private settings: Map<string, TenantInvoiceSettings> = new Map();

  setSettings(tenantId: string, s: TenantInvoiceSettings): void {
    this.settings.set(tenantId, s);
  }

  async getInvoiceSettings(tenantId: string): Promise<TenantInvoiceSettings> {
    const s = this.settings.get(tenantId);
    if (!s) {
      return {
        defaultTaxRateBps: 0,
        invoiceNumberPrefix: 'INV-',
        nextInvoiceNumber: 1,
        defaultPaymentTermDays: 30,
        currency: 'USD',
      };
    }
    return { ...s };
  }
}

export class InMemoryTechnicianUpdateRepository implements TechnicianUpdateRepository {
  private updates: Array<TechnicianUpdate & { tenantId: string; jobId: string }> = [];

  addUpdate(tenantId: string, jobId: string, update: TechnicianUpdate): void {
    this.updates.push({ ...update, tenantId, jobId });
  }

  async findByJob(tenantId: string, jobId: string): Promise<TechnicianUpdate[]> {
    return this.updates
      .filter((u) => u.tenantId === tenantId && u.jobId === jobId)
      .map(({ tenantId: _, jobId: __, ...rest }) => rest);
  }
}

export class InMemoryConversationRepository implements ConversationRepository {
  private messages: Array<ConversationMessage & { tenantId: string; jobId: string }> = [];

  addMessage(tenantId: string, jobId: string, msg: ConversationMessage): void {
    this.messages.push({ ...msg, tenantId, jobId });
  }

  async findByJob(tenantId: string, jobId: string): Promise<ConversationMessage[]> {
    return this.messages
      .filter((m) => m.tenantId === tenantId && m.jobId === jobId)
      .map(({ tenantId: _, jobId: __, ...rest }) => rest);
  }
}

export class InMemoryEstimateReferenceRepository implements EstimateReferenceRepository {
  private estimates: Array<EstimateReference & { tenantId: string; jobId: string }> = [];

  addEstimate(tenantId: string, jobId: string, est: EstimateReference): void {
    this.estimates.push({ ...est, tenantId, jobId });
  }

  async findApprovedByJob(tenantId: string, jobId: string): Promise<EstimateReference | null> {
    const found = this.estimates.find(
      (e) => e.tenantId === tenantId && e.jobId === jobId && e.status === 'accepted'
    );
    if (!found) return null;
    const { tenantId: _, jobId: __, ...rest } = found;
    return rest;
  }
}
