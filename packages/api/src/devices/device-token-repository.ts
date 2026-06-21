import { Pool, PoolClient } from 'pg';
import { randomUUID } from 'crypto';
import { PgBaseRepository } from '../db/pg-base';
import type { DevicePlatform } from '@ai-service-os/shared';

export interface DeviceToken {
  id: string;
  tenantId: string;
  userId: string;
  platform: DevicePlatform;
  token: string;
  lastSeenAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface RegisterDeviceTokenInput {
  tenantId: string;
  userId: string;
  platform: DevicePlatform;
  token: string;
}

export interface DeviceTokenRepository {
  /**
   * Upsert a device token for the tenant. Re-registering the same
   * `(tenant, token)` updates the owning user/platform and bumps
   * `last_seen_at` rather than inserting a duplicate row.
   */
  register(input: RegisterDeviceTokenInput): Promise<DeviceToken>;
  /** Tenant's device tokens (RLS-scoped); optionally narrowed to one user. */
  listByTenant(tenantId: string, userId?: string): Promise<DeviceToken[]>;
  /** Remove a token for the tenant (logout / dead-token prune). */
  deleteToken(tenantId: string, token: string): Promise<boolean>;
}

interface DeviceTokenRow {
  id: string;
  tenant_id: string;
  user_id: string;
  platform: DevicePlatform;
  token: string;
  last_seen_at: Date;
  created_at: Date;
  updated_at: Date;
}

function mapRow(row: DeviceTokenRow): DeviceToken {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    platform: row.platform,
    token: row.token,
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Postgres-backed device-token store. Every query runs through
 * `withTenant`, which sets `app.current_tenant_id` so RLS scopes the rows —
 * including in the worker send path (no request transaction). NEVER use
 * `withClient`/a raw pool query for token selection: under FORCE RLS that
 * would fail closed, but the intent is that tenant isolation is enforced by
 * the GUC on every access.
 */
export class PgDeviceTokenRepository extends PgBaseRepository implements DeviceTokenRepository {
  async register(input: RegisterDeviceTokenInput): Promise<DeviceToken> {
    return this.withTenant(input.tenantId, async (client: PoolClient) => {
      const result = await client.query<DeviceTokenRow>(
        `INSERT INTO device_tokens (tenant_id, user_id, platform, token)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, token)
         DO UPDATE SET user_id = EXCLUDED.user_id,
                       platform = EXCLUDED.platform,
                       last_seen_at = NOW(),
                       updated_at = NOW()
         RETURNING *`,
        [input.tenantId, input.userId, input.platform, input.token],
      );
      return mapRow(result.rows[0]);
    });
  }

  async listByTenant(tenantId: string, userId?: string): Promise<DeviceToken[]> {
    return this.withTenant(tenantId, async (client: PoolClient) => {
      const result = userId
        ? await client.query<DeviceTokenRow>(
            `SELECT * FROM device_tokens WHERE tenant_id = $1 AND user_id = $2 ORDER BY created_at`,
            [tenantId, userId],
          )
        : await client.query<DeviceTokenRow>(
            `SELECT * FROM device_tokens WHERE tenant_id = $1 ORDER BY created_at`,
            [tenantId],
          );
      return result.rows.map(mapRow);
    });
  }

  async deleteToken(tenantId: string, token: string): Promise<boolean> {
    return this.withTenant(tenantId, async (client: PoolClient) => {
      const result = await client.query(
        `DELETE FROM device_tokens WHERE tenant_id = $1 AND token = $2`,
        [tenantId, token],
      );
      return (result.rowCount ?? 0) > 0;
    });
  }
}

/**
 * In-memory device-token store for dev/tests. Mirrors the upsert and
 * tenant-scoping semantics of the Pg repository.
 */
export class InMemoryDeviceTokenRepository implements DeviceTokenRepository {
  private rows: DeviceToken[] = [];

  async register(input: RegisterDeviceTokenInput): Promise<DeviceToken> {
    const now = new Date();
    const existing = this.rows.find(
      (r) => r.tenantId === input.tenantId && r.token === input.token,
    );
    if (existing) {
      existing.userId = input.userId;
      existing.platform = input.platform;
      existing.lastSeenAt = now;
      existing.updatedAt = now;
      return { ...existing };
    }
    const row: DeviceToken = {
      id: randomUUID(),
      tenantId: input.tenantId,
      userId: input.userId,
      platform: input.platform,
      token: input.token,
      lastSeenAt: now,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.push(row);
    return { ...row };
  }

  async listByTenant(tenantId: string, userId?: string): Promise<DeviceToken[]> {
    return this.rows
      .filter((r) => r.tenantId === tenantId && (userId ? r.userId === userId : true))
      .map((r) => ({ ...r }));
  }

  async deleteToken(tenantId: string, token: string): Promise<boolean> {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => !(r.tenantId === tenantId && r.token === token));
    return this.rows.length < before;
  }
}
