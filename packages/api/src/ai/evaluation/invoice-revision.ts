import { v4 as uuidv4 } from 'uuid';
import {
  DocumentRevision,
  RevisionSource,
  createRevision,
  DocumentRevisionRepository,
} from '../document-revision';

export interface InvoiceRevisionInfo {
  id: string;
  tenantId: string;
  invoiceId: string;
  revisionId: string;
  isFinalApproved: boolean;
  createdAt: Date;
}

export interface InvoiceRevisionRepository {
  create(info: InvoiceRevisionInfo): Promise<InvoiceRevisionInfo>;
  findByInvoice(tenantId: string, invoiceId: string): Promise<InvoiceRevisionInfo[]>;
  markFinalApproved(tenantId: string, invoiceId: string, revisionId: string): Promise<InvoiceRevisionInfo | null>;
  getFinalApproved(tenantId: string, invoiceId: string): Promise<InvoiceRevisionInfo | null>;
}

export async function createInvoiceRevision(
  tenantId: string,
  invoiceId: string,
  snapshot: Record<string, unknown>,
  source: RevisionSource,
  actorId: string,
  actorRole: string,
  docRevisionRepo: DocumentRevisionRepository,
  invoiceRevisionRepo: InvoiceRevisionRepository,
  aiRunId?: string
): Promise<{ revision: DocumentRevision; info: InvoiceRevisionInfo }> {
  const revision = await createRevision(
    {
      tenantId,
      documentType: 'invoice',
      documentId: invoiceId,
      snapshot,
      source,
      actorId,
      actorRole,
      aiRunId,
    },
    docRevisionRepo
  );

  const info: InvoiceRevisionInfo = {
    id: uuidv4(),
    tenantId,
    invoiceId,
    revisionId: revision.id,
    isFinalApproved: false,
    createdAt: new Date(),
  };

  await invoiceRevisionRepo.create(info);

  return { revision, info };
}

export async function markInvoiceFinalApproved(
  tenantId: string,
  invoiceId: string,
  revisionId: string,
  repository: InvoiceRevisionRepository
): Promise<InvoiceRevisionInfo | null> {
  return repository.markFinalApproved(tenantId, invoiceId, revisionId);
}

export async function getInvoiceFinalApprovedRevision(
  tenantId: string,
  invoiceId: string,
  repository: InvoiceRevisionRepository
): Promise<InvoiceRevisionInfo | null> {
  return repository.getFinalApproved(tenantId, invoiceId);
}

export class InMemoryInvoiceRevisionRepository implements InvoiceRevisionRepository {
  private infos: InvoiceRevisionInfo[] = [];

  async create(info: InvoiceRevisionInfo): Promise<InvoiceRevisionInfo> {
    this.infos.push({ ...info });
    return { ...info };
  }

  async findByInvoice(tenantId: string, invoiceId: string): Promise<InvoiceRevisionInfo[]> {
    return this.infos
      .filter((i) => i.tenantId === tenantId && i.invoiceId === invoiceId)
      .map((i) => ({ ...i }));
  }

  async markFinalApproved(tenantId: string, invoiceId: string, revisionId: string): Promise<InvoiceRevisionInfo | null> {
    // Unset any previous final approved
    for (const info of this.infos) {
      if (info.tenantId === tenantId && info.invoiceId === invoiceId) {
        info.isFinalApproved = false;
      }
    }

    const target = this.infos.find(
      (i) => i.tenantId === tenantId && i.invoiceId === invoiceId && i.revisionId === revisionId
    );
    if (!target) return null;
    target.isFinalApproved = true;
    return { ...target };
  }

  async getFinalApproved(tenantId: string, invoiceId: string): Promise<InvoiceRevisionInfo | null> {
    const found = this.infos.find(
      (i) => i.tenantId === tenantId && i.invoiceId === invoiceId && i.isFinalApproved
    );
    return found ? { ...found } : null;
  }
}
