import { v4 as uuidv4 } from 'uuid';

export interface InvoiceProvenance {
  id: string;
  tenantId: string;
  proposalId: string;
  aiRunId?: string;
  promptVersionId?: string;
  sourceContext?: Record<string, unknown>;
  createdAt: Date;
}

export interface CreateInvoiceProvenanceInput {
  tenantId: string;
  proposalId: string;
  aiRunId?: string;
  promptVersionId?: string;
  sourceContext?: Record<string, unknown>;
}

export function createInvoiceProvenance(input: CreateInvoiceProvenanceInput): InvoiceProvenance {
  return {
    id: uuidv4(),
    tenantId: input.tenantId,
    proposalId: input.proposalId,
    aiRunId: input.aiRunId,
    promptVersionId: input.promptVersionId,
    sourceContext: input.sourceContext,
    createdAt: new Date(),
  };
}

export interface InvoiceProvenanceRepository {
  create(provenance: InvoiceProvenance): Promise<InvoiceProvenance>;
  findByProposalId(tenantId: string, proposalId: string): Promise<InvoiceProvenance | null>;
  findByAiRunId(tenantId: string, aiRunId: string): Promise<InvoiceProvenance[]>;
}

export class InMemoryInvoiceProvenanceRepository implements InvoiceProvenanceRepository {
  private records: Map<string, InvoiceProvenance> = new Map();

  async create(provenance: InvoiceProvenance): Promise<InvoiceProvenance> {
    this.records.set(provenance.id, { ...provenance });
    return { ...provenance };
  }

  async findByProposalId(tenantId: string, proposalId: string): Promise<InvoiceProvenance | null> {
    for (const record of this.records.values()) {
      if (record.tenantId === tenantId && record.proposalId === proposalId) {
        return { ...record };
      }
    }
    return null;
  }

  async findByAiRunId(tenantId: string, aiRunId: string): Promise<InvoiceProvenance[]> {
    return Array.from(this.records.values())
      .filter((r) => r.tenantId === tenantId && r.aiRunId === aiRunId)
      .map((r) => ({ ...r }));
  }
}
