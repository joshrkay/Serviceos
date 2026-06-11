/**
 * RV-005 — Attachments domain model.
 *
 * An `Attachment` is a join row that links a row in the existing `files`
 * table to any supported entity (job, invoice, estimate, …), plus
 * photo/document metadata (kind, caption, category, before/after pairing,
 * portal visibility). It generalizes the job-photos overlay: `job_photos`
 * stays untouched for back-compat, while new surfaces (invoice/estimate
 * photo UX, voice attach, portal galleries) read this table.
 */
import { v4 as uuidv4 } from 'uuid';

/**
 * Typed sentinel thrown by repo.pair() when one of the target attachment
 * rows is not found in the tenant. The service catches ONLY this class and
 * maps it to NotFoundError; all other errors rethrow unchanged.
 */
export class AttachmentPairTargetNotFoundError extends Error {
  constructor(public readonly attachmentId: string) {
    super(`Attachment not found: ${attachmentId}`);
    this.name = 'AttachmentPairTargetNotFoundError';
  }
}

export const ATTACHMENT_ENTITY_TYPES = [
  'job',
  'invoice',
  'estimate',
  'form_response',
  'expense',
  'agreement_run',
  'customer',
] as const;
export type AttachmentEntityType = (typeof ATTACHMENT_ENTITY_TYPES)[number];

export const ATTACHMENT_KINDS = ['photo', 'document'] as const;
export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];

export const ATTACHMENT_CATEGORIES = [
  'before',
  'after',
  'problem',
  'completion',
  'receipt',
  'signature',
  'other',
] as const;
export type AttachmentCategory = (typeof ATTACHMENT_CATEGORIES)[number];

export const ATTACHMENT_PAIR_ROLES = ['before', 'after'] as const;
export type AttachmentPairRole = (typeof ATTACHMENT_PAIR_ROLES)[number];

export const ATTACHMENT_SOURCES = ['app', 'voice', 'portal', 'sms'] as const;
export type AttachmentSource = (typeof ATTACHMENT_SOURCES)[number];

export interface Attachment {
  id: string;
  tenantId: string;
  fileId: string;
  entityType: AttachmentEntityType;
  entityId: string;
  kind: AttachmentKind;
  caption?: string;
  category?: AttachmentCategory;
  pairGroupId?: string;
  pairRole?: AttachmentPairRole;
  portalVisible: boolean;
  annotatedFileId?: string;
  uploadedBy?: string;
  source: AttachmentSource;
  sortOrder: number;
  archivedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateAttachmentInput {
  fileId: string;
  entityType: AttachmentEntityType;
  entityId: string;
  kind: AttachmentKind;
  caption?: string;
  category?: AttachmentCategory;
  uploadedBy?: string;
  source?: AttachmentSource;
  sortOrder?: number;
}

export interface ListByEntityOptions {
  includeArchived?: boolean;
  /** When true, only attachments with portal_visible = true are returned. */
  portalVisibleOnly?: boolean;
}


export interface AttachmentRepository {
  create(tenantId: string, input: CreateAttachmentInput): Promise<Attachment>;
  findById(tenantId: string, id: string): Promise<Attachment | null>;
  /**
   * Find the most-recent non-archived attachment for a given fileId + entity
   * combination. Used by dual-write delete to locate the shadow attachment row.
   */
  findByFileId(
    tenantId: string,
    fileId: string,
    entityType: AttachmentEntityType,
    entityId: string
  ): Promise<Attachment | null>;
  listByEntity(
    tenantId: string,
    entityType: AttachmentEntityType,
    entityId: string,
    options?: ListByEntityOptions
  ): Promise<Attachment[]>;
  /** Soft delete: sets archived_at. Returns null when not found in tenant. */
  archive(tenantId: string, id: string): Promise<Attachment | null>;
  setPortalVisibility(tenantId: string, id: string, visible: boolean): Promise<Attachment | null>;
  /**
   * Atomically update both attachments in a before/after pair within a single
   * transaction. Throws AttachmentPairTargetNotFoundError (rolls back) if
   * either row is not found in this tenant. Also clears pair_group_id and
   * pair_role from any OTHER rows that previously shared either attachment's
   * old pair group, so re-pairing never leaves orphaned pair members.
   */
  pair(
    tenantId: string,
    id: string,
    role: AttachmentPairRole,
    otherId: string,
    otherRole: AttachmentPairRole,
    pairGroupId: string
  ): Promise<{ attachment: Attachment; other: Attachment }>;
}

export function buildAttachment(tenantId: string, input: CreateAttachmentInput): Attachment {
  const now = new Date();
  return {
    id: uuidv4(),
    tenantId,
    fileId: input.fileId,
    entityType: input.entityType,
    entityId: input.entityId,
    kind: input.kind,
    caption: input.caption,
    category: input.category,
    portalVisible: false,
    uploadedBy: input.uploadedBy,
    source: input.source ?? 'app',
    sortOrder: input.sortOrder ?? 0,
    createdAt: now,
    updatedAt: now,
  };
}

export class InMemoryAttachmentRepository implements AttachmentRepository {
  private readonly attachments = new Map<string, Attachment>();

  async create(tenantId: string, input: CreateAttachmentInput): Promise<Attachment> {
    const attachment = buildAttachment(tenantId, input);
    this.attachments.set(attachment.id, { ...attachment });
    return { ...attachment };
  }

  async findById(tenantId: string, id: string): Promise<Attachment | null> {
    const attachment = this.attachments.get(id);
    if (!attachment || attachment.tenantId !== tenantId) return null;
    return { ...attachment };
  }

  async findByFileId(
    tenantId: string,
    fileId: string,
    entityType: AttachmentEntityType,
    entityId: string
  ): Promise<Attachment | null> {
    const found = Array.from(this.attachments.values())
      .filter(
        (a) =>
          a.tenantId === tenantId &&
          a.fileId === fileId &&
          a.entityType === entityType &&
          a.entityId === entityId &&
          !a.archivedAt
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return found.length > 0 ? { ...found[0] } : null;
  }

  async listByEntity(
    tenantId: string,
    entityType: AttachmentEntityType,
    entityId: string,
    options?: ListByEntityOptions
  ): Promise<Attachment[]> {
    return Array.from(this.attachments.values())
      .filter(
        (a) =>
          a.tenantId === tenantId &&
          a.entityType === entityType &&
          a.entityId === entityId &&
          (options?.includeArchived ? true : !a.archivedAt) &&
          (options?.portalVisibleOnly ? a.portalVisible : true)
      )
      .sort(
        (a, b) =>
          a.sortOrder - b.sortOrder || a.createdAt.getTime() - b.createdAt.getTime()
      )
      .map((a) => ({ ...a }));
  }

  async archive(tenantId: string, id: string): Promise<Attachment | null> {
    const attachment = this.attachments.get(id);
    if (!attachment || attachment.tenantId !== tenantId) return null;
    const updated: Attachment = {
      ...attachment,
      archivedAt: attachment.archivedAt ?? new Date(),
      updatedAt: new Date(),
    };
    this.attachments.set(id, updated);
    return { ...updated };
  }

  async setPortalVisibility(
    tenantId: string,
    id: string,
    visible: boolean
  ): Promise<Attachment | null> {
    const attachment = this.attachments.get(id);
    if (!attachment || attachment.tenantId !== tenantId) return null;
    const updated: Attachment = { ...attachment, portalVisible: visible, updatedAt: new Date() };
    this.attachments.set(id, updated);
    return { ...updated };
  }

  async pair(
    tenantId: string,
    id: string,
    role: AttachmentPairRole,
    otherId: string,
    otherRole: AttachmentPairRole,
    pairGroupId: string
  ): Promise<{ attachment: Attachment; other: Attachment }> {
    const attachment = this.attachments.get(id);
    if (!attachment || attachment.tenantId !== tenantId) {
      throw new AttachmentPairTargetNotFoundError(id);
    }
    const other = this.attachments.get(otherId);
    if (!other || other.tenantId !== tenantId) {
      throw new AttachmentPairTargetNotFoundError(otherId);
    }

    // Collect old pair group ids before mutating.
    const oldGroupIds = new Set<string>();
    if (attachment.pairGroupId) oldGroupIds.add(attachment.pairGroupId);
    if (other.pairGroupId) oldGroupIds.add(other.pairGroupId);

    // Clear pair fields on any OTHER rows that shared either old pair group,
    // so re-pairing never leaves orphaned pair members.
    if (oldGroupIds.size > 0) {
      for (const [rowId, row] of this.attachments.entries()) {
        if (
          rowId !== id &&
          rowId !== otherId &&
          row.tenantId === tenantId &&
          row.pairGroupId &&
          oldGroupIds.has(row.pairGroupId)
        ) {
          this.attachments.set(rowId, {
            ...row,
            pairGroupId: undefined,
            pairRole: undefined,
            updatedAt: new Date(),
          });
        }
      }
    }

    const updatedAttachment: Attachment = {
      ...attachment,
      pairGroupId,
      pairRole: role,
      updatedAt: new Date(),
    };
    const updatedOther: Attachment = {
      ...other,
      pairGroupId,
      pairRole: otherRole,
      updatedAt: new Date(),
    };
    this.attachments.set(id, updatedAttachment);
    this.attachments.set(otherId, updatedOther);
    return { attachment: { ...updatedAttachment }, other: { ...updatedOther } };
  }
}
