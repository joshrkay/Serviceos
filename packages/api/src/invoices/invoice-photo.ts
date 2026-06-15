/**
 * Invoice photos — mirrors job_photos join pattern.
 */
import { v4 as uuidv4 } from 'uuid';
import {
  JOB_PHOTO_CATEGORIES,
  JobPhotoCategory,
  isValidJobPhotoCategory,
} from '../jobs/job-photo';

export { JOB_PHOTO_CATEGORIES, type JobPhotoCategory, isValidJobPhotoCategory };

export interface InvoicePhoto {
  id: string;
  tenantId: string;
  invoiceId: string;
  uploadedByUserId: string;
  fileId: string;
  category: JobPhotoCategory;
  notes?: string;
  takenAt?: Date;
  clientVisible?: boolean;
  createdAt: Date;
}

export interface CreateInvoicePhotoInput {
  tenantId: string;
  invoiceId: string;
  uploadedByUserId: string;
  fileId: string;
  category: JobPhotoCategory;
  notes?: string;
  takenAt?: Date;
  clientVisible?: boolean;
}

export interface InvoicePhotoRepository {
  create(input: CreateInvoicePhotoInput): Promise<InvoicePhoto>;
  findById(tenantId: string, id: string): Promise<InvoicePhoto | null>;
  listByInvoice(tenantId: string, invoiceId: string): Promise<InvoicePhoto[]>;
  delete(tenantId: string, id: string): Promise<boolean>;
  updateClientVisible(tenantId: string, id: string, clientVisible: boolean): Promise<InvoicePhoto | null>;
}

export function buildInvoicePhoto(input: CreateInvoicePhotoInput): InvoicePhoto {
  return {
    id: uuidv4(),
    tenantId: input.tenantId,
    invoiceId: input.invoiceId,
    uploadedByUserId: input.uploadedByUserId,
    fileId: input.fileId,
    category: input.category,
    notes: input.notes,
    takenAt: input.takenAt,
    clientVisible: input.clientVisible ?? false,
    createdAt: new Date(),
  };
}

export class InMemoryInvoicePhotoRepository implements InvoicePhotoRepository {
  private readonly photos = new Map<string, InvoicePhoto>();

  async create(input: CreateInvoicePhotoInput): Promise<InvoicePhoto> {
    const photo = buildInvoicePhoto(input);
    this.photos.set(photo.id, { ...photo });
    return { ...photo };
  }

  async findById(tenantId: string, id: string): Promise<InvoicePhoto | null> {
    const photo = this.photos.get(id);
    if (!photo || photo.tenantId !== tenantId) return null;
    return { ...photo };
  }

  async listByInvoice(tenantId: string, invoiceId: string): Promise<InvoicePhoto[]> {
    return Array.from(this.photos.values())
      .filter((p) => p.tenantId === tenantId && p.invoiceId === invoiceId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((p) => ({ ...p }));
  }

  async delete(tenantId: string, id: string): Promise<boolean> {
    const photo = this.photos.get(id);
    if (!photo || photo.tenantId !== tenantId) return false;
    this.photos.delete(id);
    return true;
  }

  async updateClientVisible(
    tenantId: string,
    id: string,
    clientVisible: boolean,
  ): Promise<InvoicePhoto | null> {
    const photo = this.photos.get(id);
    if (!photo || photo.tenantId !== tenantId) return null;
    const updated = { ...photo, clientVisible };
    this.photos.set(id, updated);
    return { ...updated };
  }
}
