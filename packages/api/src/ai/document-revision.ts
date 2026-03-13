import { v4 as uuidv4 } from 'uuid';

export type DocumentType = 'estimate' | 'invoice' | 'proposal';
export type RevisionSource = 'manual' | 'ai_generated' | 'ai_revised';

export interface DocumentRevision {
  id: string;
  tenantId: string;
  documentType: DocumentType;
  documentId: string;
  version: number;
  snapshot: Record<string, unknown>;
  source: RevisionSource;
  actorId: string;
  actorRole: string;
  aiRunId?: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
}

export interface CreateRevisionInput {
  tenantId: string;
  documentType: DocumentType;
  documentId: string;
  snapshot: Record<string, unknown>;
  source: RevisionSource;
  actorId: string;
  actorRole: string;
  aiRunId?: string;
  metadata?: Record<string, unknown>;
}

export interface DocumentRevisionRepository {
  create(revision: DocumentRevision): Promise<DocumentRevision>;
  findById(tenantId: string, id: string): Promise<DocumentRevision | null>;
  findByDocument(tenantId: string, documentType: DocumentType, documentId: string): Promise<DocumentRevision[]>;
  getNextVersion(tenantId: string, documentType: DocumentType, documentId: string): Promise<number>;
}

export function validateRevisionInput(input: CreateRevisionInput): string[] {
  const errors: string[] = [];
  if (!input.tenantId) errors.push('tenantId is required');
  if (!input.documentType) errors.push('documentType is required');
  if (!['estimate', 'invoice', 'proposal'].includes(input.documentType)) {
    errors.push('Invalid documentType');
  }
  if (!input.documentId) errors.push('documentId is required');
  if (!input.snapshot || typeof input.snapshot !== 'object') {
    errors.push('snapshot must be a non-null object');
  }
  if (!input.source) errors.push('source is required');
  if (!['manual', 'ai_generated', 'ai_revised'].includes(input.source)) {
    errors.push('Invalid source');
  }
  if (!input.actorId) errors.push('actorId is required');
  if (!input.actorRole) errors.push('actorRole is required');
  return errors;
}

export async function createRevision(
  input: CreateRevisionInput,
  repository: DocumentRevisionRepository
): Promise<DocumentRevision> {
  const nextVersion = await repository.getNextVersion(
    input.tenantId,
    input.documentType,
    input.documentId
  );

  const revision: DocumentRevision = {
    id: uuidv4(),
    tenantId: input.tenantId,
    documentType: input.documentType,
    documentId: input.documentId,
    version: nextVersion,
    snapshot: input.snapshot,
    source: input.source,
    actorId: input.actorId,
    actorRole: input.actorRole,
    aiRunId: input.aiRunId,
    metadata: input.metadata,
    createdAt: new Date(),
  };

  await repository.create(revision);
  return revision;
}

export class InMemoryDocumentRevisionRepository implements DocumentRevisionRepository {
  private revisions: Map<string, DocumentRevision> = new Map();

  async create(revision: DocumentRevision): Promise<DocumentRevision> {
    this.revisions.set(revision.id, { ...revision });
    return revision;
  }

  async findById(tenantId: string, id: string): Promise<DocumentRevision | null> {
    const rev = this.revisions.get(id);
    if (!rev || rev.tenantId !== tenantId) return null;
    return { ...rev };
  }

  async findByDocument(
    tenantId: string,
    documentType: DocumentType,
    documentId: string
  ): Promise<DocumentRevision[]> {
    return Array.from(this.revisions.values())
      .filter(
        (r) =>
          r.tenantId === tenantId &&
          r.documentType === documentType &&
          r.documentId === documentId
      )
      .sort((a, b) => b.version - a.version);
  }

  async getNextVersion(
    tenantId: string,
    documentType: DocumentType,
    documentId: string
  ): Promise<number> {
    const revisions = await this.findByDocument(tenantId, documentType, documentId);
    if (revisions.length === 0) return 1;
    return Math.max(...revisions.map((r) => r.version)) + 1;
  }
}
