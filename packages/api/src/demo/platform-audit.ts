/**
 * U7 (S6-2) — audit rows for the demo call's platform-level mutations (the
 * start transaction, a budget crossing, a no-call release), written on the
 * hidden platform tenant (D1) in the caller's open transaction so each row
 * commits or rolls back with the mutation it records. `audit_events.tenant_id`
 * is a NOT NULL FK and FORCE-RLS: the start transaction sets the platform
 * tenant's GUC transaction-locally, so the insert passes the policy for any
 * principal. Not forwarded to product analytics: the platform tenant is
 * excluded there anyway (S6-1).
 */
import type { PoolClient } from 'pg';
import { createAuditEvent } from '../audit/audit';
import { DEMO_PLATFORM_TENANT_ID } from './platform-tenant';

/** The actor on every platform-level demo audit row. */
export const DEMO_PLATFORM_ACTOR_ID = 'system:demo-call';

export interface PlatformAuditInput {
  eventType: string;
  entityType: string;
  entityId: string;
  correlationId?: string;
  metadata?: Record<string, unknown>;
}

export async function writePlatformAudit(client: PoolClient, input: PlatformAuditInput): Promise<void> {
  const event = createAuditEvent({
    tenantId: DEMO_PLATFORM_TENANT_ID,
    actorId: DEMO_PLATFORM_ACTOR_ID,
    actorRole: 'system',
    ...input,
  });
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

/**
 * Open the platform transaction's tenant context: the platform tenant's GUC,
 * transaction-local, and no `SET ROLE` (the runtime role has no grant on the
 * platform lease table the same transaction writes). The caller must be
 * inside BEGIN; COMMIT/ROLLBACK resets it.
 */
export async function setPlatformTenantContext(client: PoolClient): Promise<void> {
  await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [DEMO_PLATFORM_TENANT_ID]);
}
