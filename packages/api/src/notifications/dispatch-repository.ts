import type { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { PgBaseRepository } from '../db/pg-base';
import { normalizeDispatchProvider } from './provider-names';

/**
 * Persistent record of every customer-facing send. Ensures we have an
 * audit trail of what message went where, with what provider message
 * ID — needed for delivery webhooks (later) and for support workflows
 * ("did the customer receive their estimate?").
 */

export type DispatchEntityType =
  | 'estimate'
  | 'invoice'
  | 'appointment_confirmation'
  | 'appointment_reschedule'
  | 'appointment_cancel'
  | 'appointment_reminder'
  | 'payment_receipt'
  | 'invoice_overdue'
  | 'delay_notice';
export type DispatchChannel = 'sms' | 'email';
export type DispatchStatus = 'sent' | 'delivered' | 'failed' | 'bounced';

export interface MessageDispatch {
  id: string;
  tenantId: string;
  entityType: DispatchEntityType;
  entityId: string;
  channel: DispatchChannel;
  recipient: string;
  provider: string;
  providerMessageId?: string;
  status: DispatchStatus;
  errorMessage?: string;
  idempotencyKey?: string;
  sentAt: Date;
  deliveredAt?: Date;
}

export interface CreateDispatchInput {
  tenantId: string;
  entityType: DispatchEntityType;
  entityId: string;
  channel: DispatchChannel;
  recipient: string;
  provider: string;
  providerMessageId?: string;
  status?: DispatchStatus;
  errorMessage?: string;
  idempotencyKey?: string;
}

export interface DispatchListOptions {
  limit?: number;
  offset?: number;
  entityType?: DispatchEntityType;
}

export interface DispatchListResult {
  dispatches: MessageDispatch[];
  total: number;
}

export interface DispatchRepository {
  create(input: CreateDispatchInput): Promise<MessageDispatch>;
  findById(tenantId: string, id: string): Promise<MessageDispatch | null>;
  findByEntity(
    tenantId: string,
    entityType: DispatchEntityType,
    entityId: string
  ): Promise<MessageDispatch[]>;
  updateStatus(
    tenantId: string,
    id: string,
    status: DispatchStatus,
    deliveredAt?: Date,
    errorMessage?: string
  ): Promise<MessageDispatch | null>;
  listByTenant(tenantId: string, options?: DispatchListOptions): Promise<DispatchListResult>;
}

export class InMemoryDispatchRepository implements DispatchRepository {
  private readonly rows = new Map<string, MessageDispatch>();

  async create(input: CreateDispatchInput): Promise<MessageDispatch> {
    const row: MessageDispatch = {
      id: uuidv4(),
      tenantId: input.tenantId,
      entityType: input.entityType,
      entityId: input.entityId,
      channel: input.channel,
      recipient: input.recipient,
      provider: normalizeDispatchProvider(input.provider),
      providerMessageId: input.providerMessageId,
      status: input.status ?? 'sent',
      errorMessage: input.errorMessage,
      idempotencyKey: input.idempotencyKey,
      sentAt: new Date(),
    };
    this.rows.set(row.id, row);
    return { ...row };
  }

  async findById(tenantId: string, id: string): Promise<MessageDispatch | null> {
    const row = this.rows.get(id);
    if (!row || row.tenantId !== tenantId) return null;
    return { ...row };
  }

  async findByEntity(
    tenantId: string,
    entityType: DispatchEntityType,
    entityId: string
  ): Promise<MessageDispatch[]> {
    return Array.from(this.rows.values())
      .filter(
        (r) =>
          r.tenantId === tenantId &&
          r.entityType === entityType &&
          r.entityId === entityId
      )
      .sort((a, b) => b.sentAt.getTime() - a.sentAt.getTime())
      .map((r) => ({ ...r }));
  }

  async updateStatus(
    tenantId: string,
    id: string,
    status: DispatchStatus,
    deliveredAt?: Date,
    errorMessage?: string
  ): Promise<MessageDispatch | null> {
    const existing = this.rows.get(id);
    if (!existing || existing.tenantId !== tenantId) return null;
    const updated: MessageDispatch = {
      ...existing,
      status,
      deliveredAt: deliveredAt ?? existing.deliveredAt,
      errorMessage: errorMessage ?? existing.errorMessage,
    };
    this.rows.set(id, updated);
    return { ...updated };
  }

  async listByTenant(tenantId: string, options?: DispatchListOptions): Promise<DispatchListResult> {
    let rows = Array.from(this.rows.values())
      .filter((r) => r.tenantId === tenantId);
    if (options?.entityType) {
      rows = rows.filter((r) => r.entityType === options.entityType);
    }
    rows.sort((a, b) => b.sentAt.getTime() - a.sentAt.getTime());
    const total = rows.length;
    const offset = options?.offset ?? 0;
    const limit = options?.limit ?? 50;
    return { dispatches: rows.slice(offset, offset + limit).map((r) => ({ ...r })), total };
  }
}

export class PgDispatchRepository extends PgBaseRepository implements DispatchRepository {
  constructor(pool: Pool) {
    super(pool);
  }

  async create(input: CreateDispatchInput): Promise<MessageDispatch> {
    return this.withTenant(input.tenantId, async (client) => {
      const id = uuidv4();
      const status: DispatchStatus = input.status ?? 'sent';
      const { rows } = await client.query(
        `INSERT INTO message_dispatches
          (id, tenant_id, entity_type, entity_id, channel, recipient,
           provider, provider_message_id, status, error_message, idempotency_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING *`,
        [
          id,
          input.tenantId,
          input.entityType,
          input.entityId,
          input.channel,
          input.recipient,
          input.provider,
          input.providerMessageId ?? null,
          status,
          input.errorMessage ?? null,
          input.idempotencyKey ?? null,
        ]
      );
      return mapRow(rows[0]);
    });
  }

  async findById(tenantId: string, id: string): Promise<MessageDispatch | null> {
    return this.withTenant(tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM message_dispatches WHERE id = $1 AND tenant_id = $2`,
        [id, tenantId]
      );
      return rows.length ? mapRow(rows[0]) : null;
    });
  }

  async findByEntity(
    tenantId: string,
    entityType: DispatchEntityType,
    entityId: string
  ): Promise<MessageDispatch[]> {
    return this.withTenant(tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM message_dispatches
         WHERE tenant_id = $1 AND entity_type = $2 AND entity_id = $3
         ORDER BY sent_at DESC`,
        [tenantId, entityType, entityId]
      );
      return rows.map(mapRow);
    });
  }

  async updateStatus(
    tenantId: string,
    id: string,
    status: DispatchStatus,
    deliveredAt?: Date,
    errorMessage?: string
  ): Promise<MessageDispatch | null> {
    return this.withTenant(tenantId, async (client) => {
      const { rows } = await client.query(
        `UPDATE message_dispatches
         SET status = $3,
             delivered_at = COALESCE($4, delivered_at),
             error_message = COALESCE($5, error_message)
         WHERE id = $1 AND tenant_id = $2
         RETURNING *`,
        [id, tenantId, status, deliveredAt ?? null, errorMessage ?? null]
      );
      return rows.length ? mapRow(rows[0]) : null;
    });
  }

  async listByTenant(tenantId: string, options?: DispatchListOptions): Promise<DispatchListResult> {
    return this.withTenant(tenantId, async (client) => {
      const limit = options?.limit ?? 50;
      const offset = options?.offset ?? 0;
      const entityTypeFilter = options?.entityType;

      const countParams: unknown[] = [tenantId];
      const dataParams: unknown[] = [tenantId];
      let whereClause = 'WHERE tenant_id = $1';

      if (entityTypeFilter) {
        countParams.push(entityTypeFilter);
        dataParams.push(entityTypeFilter);
        whereClause += ` AND entity_type = $${countParams.length}`;
      }

      const countResult = await client.query(
        `SELECT COUNT(*)::int AS total FROM message_dispatches ${whereClause}`,
        countParams,
      );
      const total: number = countResult.rows[0]?.total ?? 0;

      dataParams.push(limit, offset);
      const { rows } = await client.query(
        `SELECT * FROM message_dispatches ${whereClause}
         ORDER BY sent_at DESC
         LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}`,
        dataParams,
      );
      return { dispatches: rows.map(mapRow), total };
    });
  }
}

function mapRow(row: Record<string, any>): MessageDispatch {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    channel: row.channel,
    recipient: row.recipient,
    provider: normalizeDispatchProvider(row.provider),
    providerMessageId: row.provider_message_id ?? undefined,
    status: row.status,
    errorMessage: row.error_message ?? undefined,
    idempotencyKey: row.idempotency_key ?? undefined,
    sentAt: new Date(row.sent_at),
    deliveredAt: row.delivered_at ? new Date(row.delivered_at) : undefined,
  };
}
