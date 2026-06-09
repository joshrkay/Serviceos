import type { EventRecord, Me, TenantSettings } from '@rivet/contracts';
import { withTenantTransaction, type Db } from '../../core/db';
import type { AuthContext } from '../../http/auth';

export async function getMe(db: Db, auth: AuthContext): Promise<Me> {
  return withTenantTransaction(db, auth.tenantId, async (client) => {
    const user = await client.query(
      `SELECT u.name AS user_name, u.role, t.name AS tenant_name, t.phone, t.timezone
       FROM users u JOIN tenants t ON t.id = u.tenant_id
       WHERE u.id = $1`,
      [auth.userId],
    );
    const row = user.rows[0];
    if (!row) throw new Error('user not found in tenant context');
    return {
      userId: auth.userId,
      tenantId: auth.tenantId,
      name: row.user_name,
      role: row.role,
      tenant: { name: row.tenant_name, phone: row.phone, timezone: row.timezone },
    };
  });
}

export async function getTenantSettings(db: Db, tenantId: string): Promise<TenantSettings> {
  return withTenantTransaction(db, tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT name, phone, timezone, default_tax_rate_bps, ai_daily_quota
       FROM tenants WHERE id = $1`,
      [tenantId],
    );
    const row = rows[0];
    if (!row) throw new Error('tenant not found');
    return {
      name: row.name,
      phone: row.phone,
      timezone: row.timezone,
      defaultTaxRateBps: row.default_tax_rate_bps,
      aiDailyQuota: row.ai_daily_quota,
    };
  });
}

export async function listEvents(
  db: Db,
  tenantId: string,
  opts: { entityType?: string; limit?: number },
): Promise<EventRecord[]> {
  return withTenantTransaction(db, tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT id, event_type, entity_type, entity_id, actor_type, actor_id,
              correlation_id, payload, created_at
       FROM events
       WHERE tenant_id = $1 AND ($2::text IS NULL OR entity_type = $2)
       ORDER BY created_at DESC, id DESC
       LIMIT $3`,
      [tenantId, opts.entityType ?? null, opts.limit ?? 50],
    );
    return rows.map((row) => ({
      id: String(row.id),
      eventType: row.event_type,
      entityType: row.entity_type,
      entityId: row.entity_id,
      actorType: row.actor_type,
      actorId: row.actor_id,
      correlationId: row.correlation_id,
      payload: row.payload,
      createdAt: row.created_at.toISOString(),
    }));
  });
}
