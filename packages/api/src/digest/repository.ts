import { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import type { DigestDeliveryStatus, DigestSections } from '@ai-service-os/shared';

export interface DigestEntry {
  id: string;
  tenantId: string;
  localDate: string;
  renderedText: string;
  sections: DigestSections;
  deliveryStatus: DigestDeliveryStatus;
  deliveryAttempts: number;
  createdAt: Date;
}

export interface DigestEntryRepository {
  upsertPending(
    tenantId: string,
    localDate: string,
    renderedText: string,
    sections: DigestSections,
  ): Promise<DigestEntry>;
  findByTenantDate(tenantId: string, localDate: string): Promise<DigestEntry | null>;
  markSent(tenantId: string, id: string): Promise<void>;
  markAcked(tenantId: string, id: string): Promise<void>;
}

export class InMemoryDigestEntryRepository implements DigestEntryRepository {
  private rows = new Map<string, DigestEntry>();

  private key(tenantId: string, localDate: string): string {
    return `${tenantId}::${localDate}`;
  }

  async upsertPending(
    tenantId: string,
    localDate: string,
    renderedText: string,
    sections: DigestSections,
  ): Promise<DigestEntry> {
    const existing = this.rows.get(this.key(tenantId, localDate));
    if (existing && existing.deliveryStatus === 'sent') {
      return existing;
    }
    const row: DigestEntry = {
      id: existing?.id ?? `digest-${this.rows.size + 1}`,
      tenantId,
      localDate,
      renderedText,
      sections,
      deliveryStatus: 'pending',
      deliveryAttempts: existing?.deliveryAttempts ?? 0,
      createdAt: existing?.createdAt ?? new Date(),
    };
    this.rows.set(this.key(tenantId, localDate), row);
    return row;
  }

  async findByTenantDate(tenantId: string, localDate: string): Promise<DigestEntry | null> {
    return this.rows.get(this.key(tenantId, localDate)) ?? null;
  }

  async markSent(tenantId: string, id: string): Promise<void> {
    for (const row of this.rows.values()) {
      if (row.tenantId === tenantId && row.id === id) {
        row.deliveryStatus = 'sent';
        row.deliveryAttempts += 1;
      }
    }
  }

  async markAcked(tenantId: string, id: string): Promise<void> {
    for (const row of this.rows.values()) {
      if (row.tenantId === tenantId && row.id === id) {
        row.deliveryStatus = 'acked';
      }
    }
  }
}

export class PgDigestEntryRepository extends PgBaseRepository implements DigestEntryRepository {
  constructor(pool: Pool) {
    super(pool);
  }

  async upsertPending(
    tenantId: string,
    localDate: string,
    renderedText: string,
    sections: DigestSections,
  ): Promise<DigestEntry> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO digest_entries (
           tenant_id, local_date, rendered_text, sections, delivery_status
         ) VALUES ($1, $2, $3, $4, 'pending')
         ON CONFLICT (tenant_id, local_date)
         DO UPDATE SET
           rendered_text = EXCLUDED.rendered_text,
           sections = EXCLUDED.sections
         WHERE digest_entries.delivery_status IN ('pending', 'failed')
         RETURNING id, tenant_id, local_date, rendered_text, sections,
                   delivery_status, delivery_attempts, created_at`,
        [tenantId, localDate, renderedText, JSON.stringify(sections)],
      );
      return mapRow(result.rows[0]);
    });
  }

  async findByTenantDate(tenantId: string, localDate: string): Promise<DigestEntry | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT id, tenant_id, local_date, rendered_text, sections,
                delivery_status, delivery_attempts, created_at
         FROM digest_entries
         WHERE tenant_id = $1 AND local_date = $2`,
        [tenantId, localDate],
      );
      return result.rows[0] ? mapRow(result.rows[0]) : null;
    });
  }

  async markSent(tenantId: string, id: string): Promise<void> {
    await this.withTenant(tenantId, async (client) => {
      await client.query(
        `UPDATE digest_entries
         SET delivery_status = 'sent', delivery_attempts = delivery_attempts + 1
         WHERE id = $1`,
        [id],
      );
    });
  }

  async markAcked(tenantId: string, id: string): Promise<void> {
    await this.withTenant(tenantId, async (client) => {
      await client.query(
        `UPDATE digest_entries SET delivery_status = 'acked' WHERE id = $1`,
        [id],
      );
    });
  }
}

function mapRow(row: Record<string, unknown>): DigestEntry {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    localDate: String(row.local_date),
    renderedText: String(row.rendered_text),
    sections: (row.sections ?? {}) as DigestSections,
    deliveryStatus: row.delivery_status as DigestEntry['deliveryStatus'],
    deliveryAttempts: Number(row.delivery_attempts ?? 0),
    createdAt: row.created_at as Date,
  };
}
