import { Pool, type PoolClient } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import {
  AuditEvent,
  AuditRepository,
  RecentAuditEventsOptions,
  VOICE_APPROVAL_PIN_LOCK_EVENT_TYPES,
} from './audit';

/**
 * #1051 follow-up / #1233 review — the tenant-wide voice PIN lock lookup:
 * $1 tenant, $2 event types, $3 since. Served by migration 245's
 * `idx_audit_events_tenant_created_at` (tenant_id, created_at DESC) — a range
 * scan over the tenant's recent rows, filtered by type. Exported so the
 * integration test EXPLAINs the exact SQL that runs.
 */
export const VOICE_APPROVAL_PIN_LOCK_EVENTS_SQL = `SELECT * FROM audit_events
       WHERE tenant_id = $1
         AND event_type = ANY($2::text[])
         AND created_at >= $3
       ORDER BY created_at ASC`;

function mapRow(row: Record<string, unknown>): AuditEvent {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    actorId: row.actor_id as string,
    actorRole: row.actor_role as string,
    eventType: row.event_type as string,
    entityType: row.entity_type as string,
    entityId: row.entity_id as string,
    correlationId: row.correlation_id as string | undefined,
    metadata: row.metadata as Record<string, unknown> | undefined,
    createdAt: new Date(row.created_at as string),
  };
}

/**
 * U7-04a — the on-client audit insert: writes `event` on a client the caller
 * already holds, so the row commits or rolls back with the caller's own
 * transaction (a transcript rewrite, a purge DELETE, the demo platform
 * transaction, an alias change). `PgAuditRepository.create` checks out its
 * own tenant-scoped client instead. These two are the only statements that
 * write `audit_events`
 * (test/invariants/audit-events-raw-insert.structural.test.ts).
 *
 * The caller's client carries the transaction's tenant context. The SQL and
 * values are those of the raw inserts this replaced: an absent metadata is
 * stored as `{}` and an absent correlation id as NULL.
 */
export async function insertAuditEventOnClient(client: PoolClient, event: AuditEvent): Promise<void> {
  await client.query(
    `INSERT INTO audit_events
       (id, tenant_id, actor_id, actor_role, event_type, entity_type,
        entity_id, correlation_id, metadata, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)`,
    [
      event.id,
      event.tenantId,
      event.actorId,
      event.actorRole,
      event.eventType,
      event.entityType,
      event.entityId,
      event.correlationId ?? null,
      JSON.stringify(event.metadata ?? {}),
      event.createdAt,
    ],
  );
}

export class PgAuditRepository extends PgBaseRepository implements AuditRepository {
  constructor(pool: Pool) {
    super(pool);
  }

  async create(event: AuditEvent): Promise<AuditEvent> {
    return this.withTenant(event.tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO audit_events (id, tenant_id, actor_id, actor_role, event_type, entity_type, entity_id, correlation_id, metadata, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING *`,
        [
          event.id,
          event.tenantId,
          event.actorId,
          event.actorRole,
          event.eventType,
          event.entityType,
          event.entityId,
          event.correlationId ?? null,
          event.metadata ? JSON.stringify(event.metadata) : null,
          event.createdAt,
        ]
      );
      return mapRow(result.rows[0]);
    });
  }

  async findByEntity(tenantId: string, entityType: string, entityId: string): Promise<AuditEvent[]> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM audit_events WHERE tenant_id = $1 AND entity_type = $2 AND entity_id = $3 ORDER BY created_at DESC`,
        [tenantId, entityType, entityId]
      );
      return result.rows.map(mapRow);
    });
  }

  async findByCorrelation(tenantId: string, correlationId: string): Promise<AuditEvent[]> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM audit_events WHERE tenant_id = $1 AND correlation_id = $2 ORDER BY created_at DESC`,
        [tenantId, correlationId]
      );
      return result.rows.map(mapRow);
    });
  }

  async findVoiceApprovalPinLockEvents(tenantId: string, since: Date): Promise<AuditEvent[]> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(VOICE_APPROVAL_PIN_LOCK_EVENTS_SQL, [
        tenantId,
        [...VOICE_APPROVAL_PIN_LOCK_EVENT_TYPES],
        since,
      ]);
      return result.rows.map(mapRow);
    });
  }

  async findRecentByTenant(
    tenantId: string,
    opts: RecentAuditEventsOptions = {},
  ): Promise<AuditEvent[]> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    return this.withTenant(tenantId, async (client) => {
      // The exclusion is in SQL, before the LIMIT, so `limit` counts the
      // rows returned. `<> ALL('{}')` is true: no exclusions, no filter.
      const result = await client.query(
        `SELECT * FROM audit_events
          WHERE tenant_id = $1 AND event_type <> ALL($3::text[])
          ORDER BY created_at DESC LIMIT $2`,
        [tenantId, limit, [...(opts.excludeEventTypes ?? [])]]
      );
      return result.rows.map(mapRow);
    });
  }
}
