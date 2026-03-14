import { v4 as uuidv4 } from 'uuid';

export type InvoiceSourceType = 'job' | 'estimate' | 'conversation' | 'manual';

export interface InvoiceProvenance {
  id: string;
  tenantId: string;
  invoiceId: string;
  sourceType: InvoiceSourceType;
  sourceReference?: string;
  creatorId: string;
  creatorRole: string;
  aiRunId?: string;
  conversationId?: string;
  estimateId?: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
}

export interface CreateInvoiceProvenanceInput {
  tenantId: string;
  invoiceId: string;
  sourceType: InvoiceSourceType;
  sourceReference?: string;
  creatorId: string;
  creatorRole: string;
  aiRunId?: string;
  conversationId?: string;
  estimateId?: string;
  metadata?: Record<string, unknown>;
}

export interface InvoiceProvenanceRepository {
  create(provenance: InvoiceProvenance): Promise<InvoiceProvenance>;
  findByInvoice(tenantId: string, invoiceId: string): Promise<InvoiceProvenance | null>;
  findByTenant(tenantId: string): Promise<InvoiceProvenance[]>;
}

export function validateInvoiceProvenanceInput(input: CreateInvoiceProvenanceInput): string[] {
  const errors: string[] = [];
  if (!input.tenantId) errors.push('tenantId is required');
  if (!input.invoiceId) errors.push('invoiceId is required');
  if (!input.sourceType) {
    errors.push('sourceType is required');
  } else if (!['job', 'estimate', 'conversation', 'manual'].includes(input.sourceType)) {
    errors.push('Invalid sourceType');
  }
  if (!input.creatorId) errors.push('creatorId is required');
  if (!input.creatorRole) errors.push('creatorRole is required');
  return errors;
}

export async function createInvoiceProvenance(
  input: CreateInvoiceProvenanceInput,
  repository: InvoiceProvenanceRepository
): Promise<InvoiceProvenance> {
  const provenance: InvoiceProvenance = {
    id: uuidv4(),
    tenantId: input.tenantId,
    invoiceId: input.invoiceId,
    sourceType: input.sourceType,
    sourceReference: input.sourceReference,
    creatorId: input.creatorId,
    creatorRole: input.creatorRole,
    aiRunId: input.aiRunId,
    conversationId: input.conversationId,
    estimateId: input.estimateId,
    metadata: input.metadata,
    createdAt: new Date(),
  };

  return repository.create(provenance);
}

export class InMemoryInvoiceProvenanceRepository implements InvoiceProvenanceRepository {
  private records: Map<string, InvoiceProvenance> = new Map();

  async create(provenance: InvoiceProvenance): Promise<InvoiceProvenance> {
    this.records.set(provenance.id, { ...provenance });
    return { ...provenance };
  }

  async findByInvoice(tenantId: string, invoiceId: string): Promise<InvoiceProvenance | null> {
    const found = Array.from(this.records.values()).find(
      (p) => p.tenantId === tenantId && p.invoiceId === invoiceId
    );
    return found ? { ...found } : null;
  }

  async findByTenant(tenantId: string): Promise<InvoiceProvenance[]> {
    return Array.from(this.records.values())
      .filter((p) => p.tenantId === tenantId)
      .map((p) => ({ ...p }));
  }
}
