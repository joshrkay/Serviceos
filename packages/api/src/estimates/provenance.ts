import { v4 as uuidv4 } from 'uuid';

export type EstimateSourceType = 'manual' | 'ai_generated' | 'ai_revised' | 'template' | 'cloned';

export interface EstimateProvenance {
  id: string;
  tenantId: string;
  estimateId: string;
  sourceType: EstimateSourceType;
  sourceReference?: string;
  creatorId: string;
  creatorRole: string;
  aiRunId?: string;
  conversationId?: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
}

export interface CreateProvenanceInput {
  tenantId: string;
  estimateId: string;
  sourceType: EstimateSourceType;
  sourceReference?: string;
  creatorId: string;
  creatorRole: string;
  aiRunId?: string;
  conversationId?: string;
  metadata?: Record<string, unknown>;
}

export interface ProvenanceRepository {
  create(provenance: EstimateProvenance): Promise<EstimateProvenance>;
  findByEstimate(tenantId: string, estimateId: string): Promise<EstimateProvenance | null>;
  findByTenant(tenantId: string): Promise<EstimateProvenance[]>;
}

export function validateProvenanceInput(input: CreateProvenanceInput): string[] {
  const errors: string[] = [];
  if (!input.tenantId) errors.push('tenantId is required');
  if (!input.estimateId) errors.push('estimateId is required');
  if (!input.sourceType) errors.push('sourceType is required');
  if (!['manual', 'ai_generated', 'ai_revised', 'template', 'cloned'].includes(input.sourceType)) {
    errors.push('Invalid sourceType');
  }
  if (!input.creatorId) errors.push('creatorId is required');
  if (!input.creatorRole) errors.push('creatorRole is required');
  return errors;
}

export async function createProvenance(
  input: CreateProvenanceInput,
  repository: ProvenanceRepository
): Promise<EstimateProvenance> {
  const provenance: EstimateProvenance = {
    id: uuidv4(),
    tenantId: input.tenantId,
    estimateId: input.estimateId,
    sourceType: input.sourceType,
    sourceReference: input.sourceReference,
    creatorId: input.creatorId,
    creatorRole: input.creatorRole,
    aiRunId: input.aiRunId,
    conversationId: input.conversationId,
    metadata: input.metadata,
    createdAt: new Date(),
  };

  return repository.create(provenance);
}

export class InMemoryProvenanceRepository implements ProvenanceRepository {
  private records: Map<string, EstimateProvenance> = new Map();

  async create(provenance: EstimateProvenance): Promise<EstimateProvenance> {
    this.records.set(provenance.id, { ...provenance });
    return { ...provenance };
  }

  async findByEstimate(tenantId: string, estimateId: string): Promise<EstimateProvenance | null> {
    const found = Array.from(this.records.values()).find(
      (p) => p.tenantId === tenantId && p.estimateId === estimateId
    );
    return found ? { ...found } : null;
  }

  async findByTenant(tenantId: string): Promise<EstimateProvenance[]> {
    return Array.from(this.records.values())
      .filter((p) => p.tenantId === tenantId)
      .map((p) => ({ ...p }));
  }
}
