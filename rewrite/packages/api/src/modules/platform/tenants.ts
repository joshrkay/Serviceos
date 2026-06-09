import { z } from 'zod';
import { defineCommand } from '../../core/commands';
import type { Db } from '../../core/db';

/**
 * Tenant bootstrap is a platform operation (admin pool): it happens before
 * any tenant context exists. Everything after bootstrap is tenant-scoped.
 */
export async function createTenant(
  db: Db,
  input: {
    name: string;
    phone: string;
    timezone?: string;
    owner: { name: string; phone: string; email?: string; clerkUserId?: string };
  },
): Promise<{ tenantId: string; ownerUserId: string }> {
  const client = await db.admin.connect();
  try {
    await client.query('BEGIN');
    const tenant = await client.query<{ id: string }>(
      `INSERT INTO tenants (name, phone, timezone) VALUES ($1, $2, $3) RETURNING id`,
      [input.name, input.phone, input.timezone ?? 'America/New_York'],
    );
    const tenantId = tenant.rows[0]!.id;
    const owner = await client.query<{ id: string }>(
      `INSERT INTO users (tenant_id, role, name, phone, email, clerk_user_id)
       VALUES ($1, 'owner', $2, $3, $4, $5) RETURNING id`,
      [tenantId, input.owner.name, input.owner.phone, input.owner.email ?? null, input.owner.clerkUserId ?? null],
    );
    await client.query(
      `INSERT INTO events (tenant_id, event_type, entity_type, entity_id, actor_type, actor_id, payload)
       VALUES ($1, 'tenant.created', 'tenant', $1, 'system', NULL, '{}')`,
      [tenantId],
    );
    await client.query('COMMIT');
    return { tenantId, ownerUserId: owner.rows[0]!.id };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export const updateTenantSettingsCommand = defineCommand({
  name: 'platform.update_tenant_settings',
  input: z.object({
    name: z.string().min(1).max(200).optional(),
    phone: z.string().max(20).nullable().optional(),
    timezone: z.string().min(1).max(64).optional(),
    defaultTaxRateBps: z.number().int().min(0).max(10_000).optional(),
    aiDailyQuota: z.number().int().min(0).max(100_000).optional(),
  }),
  async run(ctx, input) {
    const { rows } = await ctx.client.query(
      `UPDATE tenants SET
         name = COALESCE($2, name),
         phone = CASE WHEN $3::boolean THEN $4 ELSE phone END,
         timezone = COALESCE($5, timezone),
         default_tax_rate_bps = COALESCE($6, default_tax_rate_bps),
         ai_daily_quota = COALESCE($7, ai_daily_quota),
         updated_at = now()
       WHERE id = $1
       RETURNING name, phone, timezone, default_tax_rate_bps, ai_daily_quota`,
      [
        ctx.tenantId,
        input.name ?? null,
        input.phone !== undefined,
        input.phone ?? null,
        input.timezone ?? null,
        input.defaultTaxRateBps ?? null,
        input.aiDailyQuota ?? null,
      ],
    );
    ctx.emit({
      eventType: 'tenant.settings_updated',
      entityType: 'tenant',
      entityId: ctx.tenantId,
      payload: { changedFields: Object.keys(input) },
    });
    const row = rows[0]!;
    return {
      name: row.name as string,
      phone: row.phone as string | null,
      timezone: row.timezone as string,
      defaultTaxRateBps: row.default_tax_rate_bps as number,
      aiDailyQuota: row.ai_daily_quota as number,
    };
  },
});
