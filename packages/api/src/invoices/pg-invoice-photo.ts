import { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import {
  CreateInvoicePhotoInput,
  InvoicePhoto,
  InvoicePhotoRepository,
  JobPhotoCategory,
  buildInvoicePhoto,
} from './invoice-photo';

function mapRow(row: Record<string, unknown>): InvoicePhoto {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    invoiceId: row.invoice_id as string,
    uploadedByUserId: row.uploaded_by_user_id as string,
    fileId: row.file_id as string,
    category: row.category as JobPhotoCategory,
    notes: (row.notes as string | null) ?? undefined,
    takenAt: row.taken_at ? new Date(row.taken_at as string) : undefined,
    clientVisible: row.client_visible === true,
    createdAt: new Date(row.created_at as string),
  };
}

export class PgInvoicePhotoRepository extends PgBaseRepository implements InvoicePhotoRepository {
  constructor(pool: Pool) {
    super(pool);
  }

  async create(input: CreateInvoicePhotoInput): Promise<InvoicePhoto> {
    const photo = buildInvoicePhoto(input);
    return this.withTenant(photo.tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO invoice_photos
           (id, tenant_id, invoice_id, uploaded_by_user_id, file_id, category, notes, taken_at, client_visible, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING *`,
        [
          photo.id,
          photo.tenantId,
          photo.invoiceId,
          photo.uploadedByUserId,
          photo.fileId,
          photo.category,
          photo.notes ?? null,
          photo.takenAt ?? null,
          photo.clientVisible === true,
          photo.createdAt,
        ],
      );
      return mapRow(result.rows[0]);
    });
  }

  async findById(tenantId: string, id: string): Promise<InvoicePhoto | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM invoice_photos WHERE id = $1 AND tenant_id = $2`,
        [id, tenantId],
      );
      if (result.rows.length === 0) return null;
      return mapRow(result.rows[0]);
    });
  }

  async listByInvoice(tenantId: string, invoiceId: string): Promise<InvoicePhoto[]> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM invoice_photos
         WHERE tenant_id = $1 AND invoice_id = $2
         ORDER BY created_at DESC`,
        [tenantId, invoiceId],
      );
      return result.rows.map(mapRow);
    });
  }

  async delete(tenantId: string, id: string): Promise<boolean> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `DELETE FROM invoice_photos WHERE id = $1 AND tenant_id = $2`,
        [id, tenantId],
      );
      return (result.rowCount ?? 0) > 0;
    });
  }

  async updateClientVisible(
    tenantId: string,
    id: string,
    clientVisible: boolean,
  ): Promise<InvoicePhoto | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `UPDATE invoice_photos SET client_visible = $3
         WHERE id = $1 AND tenant_id = $2
         RETURNING *`,
        [id, tenantId, clientVisible],
      );
      if (result.rows.length === 0) return null;
      return mapRow(result.rows[0]);
    });
  }
}
