import { v4 as uuidv4 } from 'uuid';

export type InvoiceApprovalStatus = 'pending' | 'approved' | 'approved_with_edits' | 'rejected';

export interface InvoiceApprovalOutcome {
  id: string;
  tenantId: string;
  invoiceId: string;
  proposalId: string;
  status: InvoiceApprovalStatus;
  approvedBy?: string;
  approvedAt?: Date;
  rejectedBy?: string;
  rejectedAt?: Date;
  rejectionReason?: string;
  approvedWithEdits: boolean;
  finalRevisionId?: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
}

export interface RecordInvoiceApprovalInput {
  tenantId: string;
  invoiceId: string;
  proposalId: string;
  approvedBy: string;
  approvedWithEdits?: boolean;
  finalRevisionId?: string;
  metadata?: Record<string, unknown>;
}

export interface RecordInvoiceRejectionInput {
  tenantId: string;
  invoiceId: string;
  proposalId: string;
  rejectedBy: string;
  rejectionReason?: string;
  metadata?: Record<string, unknown>;
}

export interface InvoiceApprovalRepository {
  create(approval: InvoiceApprovalOutcome): Promise<InvoiceApprovalOutcome>;
  findByInvoice(tenantId: string, invoiceId: string): Promise<InvoiceApprovalOutcome | null>;
  findByTenant(tenantId: string): Promise<InvoiceApprovalOutcome[]>;
}

export function validateInvoiceApprovalInput(input: RecordInvoiceApprovalInput): string[] {
  const errors: string[] = [];
  if (!input.tenantId) errors.push('tenantId is required');
  if (!input.invoiceId) errors.push('invoiceId is required');
  if (!input.proposalId) errors.push('proposalId is required');
  if (!input.approvedBy) errors.push('approvedBy is required');
  return errors;
}

export function validateInvoiceRejectionInput(input: RecordInvoiceRejectionInput): string[] {
  const errors: string[] = [];
  if (!input.tenantId) errors.push('tenantId is required');
  if (!input.invoiceId) errors.push('invoiceId is required');
  if (!input.proposalId) errors.push('proposalId is required');
  if (!input.rejectedBy) errors.push('rejectedBy is required');
  return errors;
}

async function ensureNoExistingDecision(
  repository: InvoiceApprovalRepository,
  tenantId: string,
  invoiceId: string
): Promise<void> {
  const existing = await repository.findByInvoice(tenantId, invoiceId);
  if (existing) throw new Error('Approval or rejection already recorded for this invoice');
}

export async function recordInvoiceApproval(
  input: RecordInvoiceApprovalInput,
  repository: InvoiceApprovalRepository
): Promise<InvoiceApprovalOutcome> {
  await ensureNoExistingDecision(repository, input.tenantId, input.invoiceId);

  const approval: InvoiceApprovalOutcome = {
    id: uuidv4(),
    tenantId: input.tenantId,
    invoiceId: input.invoiceId,
    proposalId: input.proposalId,
    status: input.approvedWithEdits ? 'approved_with_edits' : 'approved',
    approvedBy: input.approvedBy,
    approvedAt: new Date(),
    approvedWithEdits: input.approvedWithEdits ?? false,
    finalRevisionId: input.finalRevisionId,
    metadata: input.metadata,
    createdAt: new Date(),
  };

  return repository.create(approval);
}

export async function recordInvoiceRejection(
  input: RecordInvoiceRejectionInput,
  repository: InvoiceApprovalRepository
): Promise<InvoiceApprovalOutcome> {
  await ensureNoExistingDecision(repository, input.tenantId, input.invoiceId);

  const approval: InvoiceApprovalOutcome = {
    id: uuidv4(),
    tenantId: input.tenantId,
    invoiceId: input.invoiceId,
    proposalId: input.proposalId,
    status: 'rejected',
    rejectedBy: input.rejectedBy,
    rejectedAt: new Date(),
    rejectionReason: input.rejectionReason,
    approvedWithEdits: false,
    metadata: input.metadata,
    createdAt: new Date(),
  };

  return repository.create(approval);
}

export class InMemoryInvoiceApprovalRepository implements InvoiceApprovalRepository {
  private approvals: Map<string, InvoiceApprovalOutcome> = new Map();

  async create(approval: InvoiceApprovalOutcome): Promise<InvoiceApprovalOutcome> {
    this.approvals.set(approval.id, { ...approval });
    return { ...approval };
  }

  async findByInvoice(tenantId: string, invoiceId: string): Promise<InvoiceApprovalOutcome | null> {
    const found = Array.from(this.approvals.values()).find(
      (a) => a.tenantId === tenantId && a.invoiceId === invoiceId
    );
    return found ? { ...found } : null;
  }

  async findByTenant(tenantId: string): Promise<InvoiceApprovalOutcome[]> {
    return Array.from(this.approvals.values())
      .filter((a) => a.tenantId === tenantId)
      .map((a) => ({ ...a }));
  }
}
