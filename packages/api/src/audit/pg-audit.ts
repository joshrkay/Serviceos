import { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import { AuditEvent, AuditRepository } from './audit';

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
}
