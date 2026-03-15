import { v4 as uuidv4 } from 'uuid';

export interface EstimateProvenance {
  id: string;
  tenantId: string;
  estimateId: string;
  templateId?: string;
  sourceSignals: string[];
  aiRunId?: string;
  createdAt: Date;
}

export interface CreateEstimateProvenanceInput {
  tenantId: string;
  estimateId: string;
  templateId?: string;
  sourceSignals: string[];
  aiRunId?: string;
}

export interface EstimateProvenanceRepository {
  create(provenance: EstimateProvenance): Promise<EstimateProvenance>;
  findByEstimate(tenantId: string, estimateId: string): Promise<EstimateProvenance[]>;
  findByTemplate(tenantId: string, templateId: string): Promise<EstimateProvenance[]>;
}

export function validateEstimateProvenanceInput(input: CreateEstimateProvenanceInput): string[] {
  const errors: string[] = [];
  if (!input.tenantId) errors.push('tenantId is required');
  if (!input.estimateId) errors.push('estimateId is required');
  if (!Array.isArray(input.sourceSignals)) errors.push('sourceSignals must be an array');
  return errors;
}

export function createEstimateProvenance(input: CreateEstimateProvenanceInput): EstimateProvenance {
  return {
    id: uuidv4(),
    tenantId: input.tenantId,
    estimateId: input.estimateId,
    templateId: input.templateId,
    sourceSignals: input.sourceSignals,
    aiRunId: input.aiRunId,
    createdAt: new Date(),
  };
}

export class InMemoryEstimateProvenanceRepository implements EstimateProvenanceRepository {
  private records: Map<string, EstimateProvenance> = new Map();

  async create(provenance: EstimateProvenance): Promise<EstimateProvenance> {
    this.records.set(provenance.id, { ...provenance });
    return { ...provenance };
  }

  async findByEstimate(tenantId: string, estimateId: string): Promise<EstimateProvenance[]> {
    return Array.from(this.records.values())
      .filter((r) => r.tenantId === tenantId && r.estimateId === estimateId)
      .map((r) => ({ ...r }));
  }

  async findByTemplate(tenantId: string, templateId: string): Promise<EstimateProvenance[]> {
    return Array.from(this.records.values())
      .filter((r) => r.tenantId === tenantId && r.templateId === templateId)
      .map((r) => ({ ...r }));
  }
}
