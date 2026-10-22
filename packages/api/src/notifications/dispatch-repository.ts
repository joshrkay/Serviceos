import type { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { PgBaseRepository } from '../db/pg-base';
import { normalizeDispatchProvider } from './provider-names';
import type { MessagePurpose } from './outbound-messaging';

/**
 * Persistent record of every customer-facing send. Ensures we have an
 * audit trail of what message went where, with what provider message
 * ID — needed for delivery webhooks (later) and for support workflows
 * ("did the customer receive their estimate?").
 *
 * D-045 — outbound messaging also records texts that did not reach a
 * provider: 'scheduled' (held for the customer's daytime window) and
 * 'blocked' (refused, with the reason). One row per message, keyed by its
 * dedupe key, linked to the customer and, when there is one, the job.
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
  | 'delay_notice'
  | 'appointment_en_route'
  // RV-061 — owner end-of-day digest SMS (entity_id = daily_digests.id).
  | 'daily_digest'
  // U6 (CRM Jobber parity, Phase 2) — owner-authored conversation reply
  // (free-text SMS/email from the unified inbox; entity_id = conversations.id).
  | 'conversation_reply'
  // Customer-portal link delivery (entity_id = portal_sessions.id). Added
  // to the message_dispatches entity_type CHECK in migration
  // 269_dispatch_entity_portal_session (db/schema.ts).
  | 'portal_session'
  // Tradesperson wave 1, Task 5 — a free-form owner-approved customer
  // message (send_customer_message proposal; entity_id = customers.id).
  // Added to the message_dispatches entity_type CHECK in migration
  // 270_dispatch_entity_custom_message (db/schema.ts) — the current final
  // widening; test/db/dispatch-entity-type-vocabulary.test.ts pins this
  // union against the CHECK constraint's effective value list.
  | 'custom_message'
  // D-045 — the after-job thank-you text (entity_id = jobs.id). Migration
  // 329_message_dispatch_outcomes.
  | 'thank_you';
export type DispatchChannel = 'sms' | 'email';
export const DISPATCH_STATUSES = ['sent', 'delivered', 'failed', 'bounced', 'scheduled', 'blocked'] as const;
export type DispatchStatus = (typeof DISPATCH_STATUSES)[number];

/**
 * Provider of a sent record backfilled by a retry that knew only that the
 * text went out (no number, no receipt). The attempt that sent it may still
 * fill in the real receipt over it.
 */
export const UNKNOWN_PROVIDER = 'unknown';

/** Statuses of a message that reached a provider — what "was it sent?" asks. */
export const PROVIDER_ATTEMPT_STATUSES: readonly DispatchStatus[] = ['sent', 'delivered', 'failed', 'bounced'];

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
  /** Time of the latest outcome (for scheduled and blocked rows, when it was recorded). */
  sentAt: Date;
  deliveredAt?: Date;
  customerId?: string;
  jobId?: string;
  purpose?: MessagePurpose;
  /** For 'scheduled': when the customer's send window opens. */
  scheduledFor?: Date;
  /** For 'blocked': why, and whether it will clear without someone acting. */
  blockReason?: string;
  blockPermanent?: boolean;
}

/**
 * One message's outcome, recorded by outbound messaging under its dedupe key.
 * A later outcome for the same key replaces an earlier scheduled or blocked
 * one; a row that reached a provider (sent, delivered, failed, bounced) is
 * never overwritten, except that a real receipt replaces a backfilled
 * placeholder (`UNKNOWN_PROVIDER`).
 */
export interface RecordOutcomeInput {
  tenantId: string;
  idempotencyKey: string;
  entityType: DispatchEntityType;
  entityId: string;
  channel: DispatchChannel;
  /** '' when the text was blocked before a number was known. */
  recipient: string;
  purpose: MessagePurpose;
  customerId?: string;
  jobId?: string;
  outcome:
    | { status: 'sent'; provider: string; providerMessageId?: string }
    | { status: 'scheduled'; scheduledFor: Date }
    | { status: 'blocked'; reason: string; permanent: boolean; detail?: string };
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
  status?: DispatchStatus;
  customerId?: string;
  jobId?: string;
}

export interface DispatchListResult {
  dispatches: MessageDispatch[];
  total: number;
}

export interface DispatchRepository {
  create(input: CreateDispatchInput): Promise<MessageDispatch>;
  findById(tenantId: string, id: string): Promise<MessageDispatch | null>;
  /** Rows that reached a provider (see `PROVIDER_ATTEMPT_STATUSES`), newest first. */
  findByEntity(
    tenantId: string,
    entityType: DispatchEntityType,
    entityId: string
  ): Promise<MessageDispatch[]>;
  recordOutcome(input: RecordOutcomeInput): Promise<MessageDispatch>;
  updateStatus(
    tenantId: string,
    id: string,
    status: DispatchStatus,
    deliveredAt?: Date,
    errorMessage?: string
  ): Promise<MessageDispatch | null>;
  listByTenant(tenantId: string, options?: DispatchListOptions): Promise<DispatchListResult>;
  /**
   * #1400 — the dispatch already recorded under this idempotency key
   * (`idx_dispatches_idempotency` is UNIQUE (tenant_id, idempotency_key)),
   * so a same-occasion retry replays it instead of tripping the index.
   * Optional so partial test doubles stay valid.
   */
  findByIdempotencyKey?(tenantId: string, idempotencyKey: string): Promise<MessageDispatch | null>;
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
          r.entityId === entityId &&
          PROVIDER_ATTEMPT_STATUSES.includes(r.status)
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

  async recordOutcome(input: RecordOutcomeInput): Promise<MessageDispatch> {
    const existing = Array.from(this.rows.values()).find(
      (r) => r.tenantId === input.tenantId && r.idempotencyKey === input.idempotencyKey,
    );
    if (existing && !replaces(existing, input)) return { ...existing };
    const columns = outcomeColumns(input);
    const row: MessageDispatch = {
      ...columns,
      // A backfill that never learned the number keeps the one already known.
      recipient: columns.recipient || existing?.recipient || '',
      id: existing?.id ?? uuidv4(),
      sentAt: new Date(),
    };
    this.rows.set(row.id, row);
    return { ...row };
  }

  async findByIdempotencyKey(tenantId: string, idempotencyKey: string): Promise<MessageDispatch | null> {
    const row = Array.from(this.rows.values()).find(
      (r) => r.tenantId === tenantId && r.idempotencyKey === idempotencyKey,
    );
    return row ? { ...row } : null;
  }

  async listByTenant(tenantId: string, options?: DispatchListOptions): Promise<DispatchListResult> {
    let rows = Array.from(this.rows.values())
      .filter((r) => r.tenantId === tenantId);
    if (options?.entityType) {
      rows = rows.filter((r) => r.entityType === options.entityType);
    }
    if (options?.status) rows = rows.filter((r) => r.status === options.status);
    if (options?.customerId) rows = rows.filter((r) => r.customerId === options.customerId);
    if (options?.jobId) rows = rows.filter((r) => r.jobId === options.jobId);
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
           AND status = ANY($4::text[])
         ORDER BY sent_at DESC`,
        [tenantId, entityType, entityId, PROVIDER_ATTEMPT_STATUSES]
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

  async recordOutcome(input: RecordOutcomeInput): Promise<MessageDispatch> {
    const c = outcomeColumns(input);
    return this.withTenant(input.tenantId, async (client) => {
      // One row per message: a later outcome replaces a scheduled or blocked
      // one, and a row that reached a provider is never overwritten (save a
      // backfilled placeholder, which a real receipt fills in). Same rule as
      // `replaces` below.
      const { rows } = await client.query(
        `INSERT INTO message_dispatches
          (id, tenant_id, entity_type, entity_id, channel, recipient, provider,
           provider_message_id, status, error_message, idempotency_key,
           customer_id, job_id, purpose, scheduled_for, block_reason, block_permanent)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         ON CONFLICT (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL
         DO UPDATE SET
           entity_type = EXCLUDED.entity_type, entity_id = EXCLUDED.entity_id,
           channel = EXCLUDED.channel,
           -- A backfill that never learned the number keeps the one already known.
           recipient = COALESCE(NULLIF(EXCLUDED.recipient, ''), message_dispatches.recipient),
           provider = EXCLUDED.provider, provider_message_id = EXCLUDED.provider_message_id,
           status = EXCLUDED.status, error_message = EXCLUDED.error_message,
           customer_id = EXCLUDED.customer_id, job_id = EXCLUDED.job_id,
           purpose = EXCLUDED.purpose, scheduled_for = EXCLUDED.scheduled_for,
           block_reason = EXCLUDED.block_reason, block_permanent = EXCLUDED.block_permanent,
           sent_at = NOW()
         WHERE message_dispatches.status IN ('scheduled', 'blocked')
            OR (message_dispatches.status = 'sent'
                AND message_dispatches.provider = '${UNKNOWN_PROVIDER}'
                AND EXCLUDED.status = 'sent'
                AND EXCLUDED.provider <> '${UNKNOWN_PROVIDER}')
         RETURNING *`,
        [
          uuidv4(),
          c.tenantId,
          c.entityType,
          c.entityId,
          c.channel,
          c.recipient,
          c.provider,
          c.providerMessageId ?? null,
          c.status,
          c.errorMessage ?? null,
          c.idempotencyKey,
          c.customerId ?? null,
          c.jobId ?? null,
          c.purpose,
          c.scheduledFor ?? null,
          c.blockReason ?? null,
          c.blockPermanent ?? null,
        ],
      );
      if (rows.length) return mapRow(rows[0]);
      // Already sent or delivered: the existing row stands.
      const existing = await client.query(
        `SELECT * FROM message_dispatches WHERE tenant_id = $1 AND idempotency_key = $2`,
        [c.tenantId, c.idempotencyKey],
      );
      return mapRow(existing.rows[0]);
    });
  }

  async findByIdempotencyKey(tenantId: string, idempotencyKey: string): Promise<MessageDispatch | null> {
    return this.withTenant(tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM message_dispatches WHERE tenant_id = $1 AND idempotency_key = $2`,
        [tenantId, idempotencyKey]
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
      for (const [column, value] of [
        ['status', options?.status],
        ['customer_id', options?.customerId],
        ['job_id', options?.jobId],
      ] as const) {
        if (!value) continue;
        countParams.push(value);
        dataParams.push(value);
        whereClause += ` AND ${column} = $${countParams.length}`;
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
    customerId: row.customer_id ?? undefined,
    jobId: row.job_id ?? undefined,
    purpose: row.purpose ?? undefined,
    scheduledFor: row.scheduled_for ? new Date(row.scheduled_for) : undefined,
    blockReason: row.block_reason ?? undefined,
    blockPermanent: row.block_permanent ?? undefined,
  };
}

/** The row a recorded outcome describes, minus id and time. */
function outcomeColumns(input: RecordOutcomeInput): Omit<MessageDispatch, 'id' | 'sentAt'> & { idempotencyKey: string } {
  const { outcome } = input;
  return {
    tenantId: input.tenantId,
    entityType: input.entityType,
    entityId: input.entityId,
    channel: input.channel,
    recipient: input.recipient,
    idempotencyKey: input.idempotencyKey,
    customerId: input.customerId,
    jobId: input.jobId,
    purpose: input.purpose,
    status: outcome.status,
    provider: outcome.status === 'sent' ? normalizeDispatchProvider(outcome.provider) : 'none',
    providerMessageId: outcome.status === 'sent' ? outcome.providerMessageId : undefined,
    scheduledFor: outcome.status === 'scheduled' ? outcome.scheduledFor : undefined,
    blockReason: outcome.status === 'blocked' ? outcome.reason : undefined,
    blockPermanent: outcome.status === 'blocked' ? outcome.permanent : undefined,
    errorMessage: outcome.status === 'blocked' ? outcome.detail : undefined,
  };
}

/** Whether a new outcome may replace the recorded one for the same message. */
function replaces(existing: MessageDispatch, input: RecordOutcomeInput): boolean {
  if (existing.status === 'scheduled' || existing.status === 'blocked') return true;
  return (
    existing.status === 'sent' &&
    existing.provider === UNKNOWN_PROVIDER &&
    input.outcome.status === 'sent' &&
    normalizeDispatchProvider(input.outcome.provider) !== UNKNOWN_PROVIDER
  );
}
