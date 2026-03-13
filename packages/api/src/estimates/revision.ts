import { v4 as uuidv4 } from 'uuid';
import {
  DocumentRevision,
  RevisionSource,
  CreateRevisionInput,
  createRevision,
  DocumentRevisionRepository,
} from '../ai/document-revision';

export interface EstimateRevisionInfo {
  id: string;
  tenantId: string;
  estimateId: string;
  revisionId: string;
  isFinalApproved: boolean;
  createdAt: Date;
}

export interface EstimateRevisionRepository {
  create(info: EstimateRevisionInfo): Promise<EstimateRevisionInfo>;
  findByEstimate(tenantId: string, estimateId: string): Promise<EstimateRevisionInfo[]>;
  markFinalApproved(tenantId: string, estimateId: string, revisionId: string): Promise<EstimateRevisionInfo | null>;
  getFinalApproved(tenantId: string, estimateId: string): Promise<EstimateRevisionInfo | null>;
}

export async function createEstimateRevision(
  tenantId: string,
  estimateId: string,
  snapshot: Record<string, unknown>,
  source: RevisionSource,
  actorId: string,
  actorRole: string,
  docRevisionRepo: DocumentRevisionRepository,
  estimateRevisionRepo: EstimateRevisionRepository,
  aiRunId?: string
): Promise<{ revision: DocumentRevision; info: EstimateRevisionInfo }> {
  const revision = await createRevision(
    {
      tenantId,
      documentType: 'estimate',
      documentId: estimateId,
      snapshot,
      source,
      actorId,
      actorRole,
      aiRunId,
    },
    docRevisionRepo
  );

  const info: EstimateRevisionInfo = {
    id: uuidv4(),
    tenantId,
    estimateId,
    revisionId: revision.id,
    isFinalApproved: false,
    createdAt: new Date(),
  };

  await estimateRevisionRepo.create(info);

  return { revision, info };
}

export async function markFinalApproved(
  tenantId: string,
  estimateId: string,
  revisionId: string,
  repository: EstimateRevisionRepository
): Promise<EstimateRevisionInfo | null> {
  return repository.markFinalApproved(tenantId, estimateId, revisionId);
}

export async function getFinalApprovedRevision(
  tenantId: string,
  estimateId: string,
  repository: EstimateRevisionRepository
): Promise<EstimateRevisionInfo | null> {
  return repository.getFinalApproved(tenantId, estimateId);
}

export class InMemoryEstimateRevisionRepository implements EstimateRevisionRepository {
  private infos: EstimateRevisionInfo[] = [];

  async create(info: EstimateRevisionInfo): Promise<EstimateRevisionInfo> {
    this.infos.push({ ...info });
    return { ...info };
  }

  async findByEstimate(tenantId: string, estimateId: string): Promise<EstimateRevisionInfo[]> {
    return this.infos
      .filter((i) => i.tenantId === tenantId && i.estimateId === estimateId)
      .map((i) => ({ ...i }));
  }

  async markFinalApproved(tenantId: string, estimateId: string, revisionId: string): Promise<EstimateRevisionInfo | null> {
    // Unset any previous final approved
    for (const info of this.infos) {
      if (info.tenantId === tenantId && info.estimateId === estimateId) {
        info.isFinalApproved = false;
      }
    }

    const target = this.infos.find(
      (i) => i.tenantId === tenantId && i.estimateId === estimateId && i.revisionId === revisionId
    );
    if (!target) return null;
    target.isFinalApproved = true;
    return { ...target };
  }

  async getFinalApproved(tenantId: string, estimateId: string): Promise<EstimateRevisionInfo | null> {
    const found = this.infos.find(
      (i) => i.tenantId === tenantId && i.estimateId === estimateId && i.isFinalApproved
    );
    return found ? { ...found } : null;
  }
}
