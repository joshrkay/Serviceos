import { v4 as uuidv4 } from 'uuid';
import type { Pool } from 'pg';
import { PgBaseRepository } from '../../db/pg-base';
import { ValidationError } from '../../shared/errors';
import {
  AccountingIntegration,
  AccountingIntegrationRepository,
  AccountingIntegrationStatus,
  AccountingOAuthStateRepository,
  AccountingProvider,
  AccountingSyncAction,
  AccountingSyncEntityType,
  AccountingSyncLogEntry,
  AccountingSyncLogRepository,
  AccountingSyncStatus,
  CreateAccountingSyncLogInput,
  UpsertAccountingIntegrationInput,
} from './types';
import { decryptAccountingToken, encryptAccountingToken } from './token-crypto';

/* ───────────── In-memory (tests) ───────────── */

export class InMemoryAccountingIntegrationRepository implements AccountingIntegrationRepository {
  private rows = new Map<string, AccountingIntegration>();

  async upsert(input: UpsertAccountingIntegrationInput): Promise<AccountingIntegration> {
    const existing = await this.findByTenant(input.tenantId, input.provider);
    const now = new Date();
    const next: AccountingIntegration = {
      id: existing?.id ?? uuidv4(),
      tenantId: input.tenantId,
      provider: input.provider,
      accessTokenEncrypted: encryptAccountingToken(input.accessToken),
      refreshTokenEncrypted: encryptAccountingToken(input.refreshToken),
      realmId: input.realmId,
      connectedAt: existing?.connectedAt ?? now,
      lastSyncedAt: existing?.lastSyncedAt ?? null,
      status: 'active',
      errorMessage: null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.rows.set(next.id, next);
    return { ...next };
  }

  async findByTenant(
    tenantId: string,
    provider: AccountingProvider = 'quickbooks',
  ): Promise<AccountingIntegration | null> {
    for (const row of this.rows.values()) {
      if (row.tenantId === tenantId && row.provider === provider) {
        return { ...row };
      }
    }
    return null;
  }

  async findAllActive(): Promise<AccountingIntegration[]> {
    return Array.from(this.rows.values())
      .filter((r) => r.status === 'active')
      .map((r) => ({ ...r }));
  }

  async updateLastSyncedAt(tenantId: string, id: string, at: Date): Promise<void> {
    const row = this.rows.get(id);
    if (!row || row.tenantId !== tenantId) return;
    this.rows.set(id, { ...row, lastSyncedAt: at, updatedAt: new Date() });
  }

  async setStatus(
    tenantId: string,
    id: string,
    status: AccountingIntegrationStatus,
    errorMessage: string | null = null,
  ): Promise<AccountingIntegration | null> {
    const row = this.rows.get(id);
    if (!row || row.tenantId !== tenantId) return null;
    const next = { ...row, status, errorMessage, updatedAt: new Date() };
    this.rows.set(id, next);
    return { ...next };
  }

  async updateTokens(
    tenantId: string,
    id: string,
    accessTokenEncrypted: string,
    refreshTokenEncrypted: string,
  ): Promise<AccountingIntegration | null> {
    const row = this.rows.get(id);
    if (!row || row.tenantId !== tenantId) return null;
    const next = {
      ...row,
      accessTokenEncrypted,
      refreshTokenEncrypted,
      status: 'active' as const,
      errorMessage: null,
      updatedAt: new Date(),
    };
    this.rows.set(id, next);
    return { ...next };
  }

  async disconnect(tenantId: string, provider: AccountingProvider): Promise<boolean> {
    const row = await this.findByTenant(tenantId, provider);
    if (!row) return false;
    await this.setStatus(tenantId, row.id, 'disconnected');
    return true;
  }
}

export class InMemoryAccountingSyncLogRepository implements AccountingSyncLogRepository {
  private rows: AccountingSyncLogEntry[] = [];

  async create(input: CreateAccountingSyncLogInput): Promise<AccountingSyncLogEntry> {
    const entry: AccountingSyncLogEntry = {
      id: uuidv4(),
      tenantId: input.tenantId,
      integrationId: input.integrationId,
      entityType: input.entityType,
      entityId: input.entityId,
      externalId: input.externalId ?? null,
      action: input.action,
      status: input.status,
      payloadHash: input.payloadHash,
      errorMessage: input.errorMessage ?? null,
      syncedAt: new Date(),
    };
    this.rows.push(entry);
    return { ...entry };
  }

  async findSuccessfulPush(
    tenantId: string,
    integrationId: string,
    entityType: AccountingSyncEntityType,
    entityId: string,
    payloadHash: string,
  ): Promise<AccountingSyncLogEntry | null> {
    const hit = this.rows.find(
      (r) =>
        r.tenantId === tenantId &&
        r.integrationId === integrationId &&
        r.entityType === entityType &&
        r.entityId === entityId &&
        r.payloadHash === payloadHash &&
        r.status === 'success' &&
        r.action === 'push',
    );
    return hit ? { ...hit } : null;
  }

  async findExternalIdForEntity(
    tenantId: string,
    integrationId: string,
    entityType: AccountingSyncEntityType,
    entityId: string,
  ): Promise<string | null> {
    const hits = this.rows
      .filter(
        (r) =>
          r.tenantId === tenantId &&
          r.integrationId === integrationId &&
          r.entityType === entityType &&
          r.entityId === entityId &&
          r.status === 'success' &&
          r.externalId,
      )
      .sort((a, b) => b.syncedAt.getTime() - a.syncedAt.getTime());
    return hits[0]?.externalId ?? null;
  }

  async countRecentFailures(
    tenantId: string,
    integrationId: string,
    since: Date,
  ): Promise<number> {
    return this.rows.filter(
      (r) =>
        r.tenantId === tenantId &&
        r.integrationId === integrationId &&
        r.status === 'failed' &&
        r.syncedAt.getTime() >= since.getTime(),
    ).length;
  }

  async listRecent(
    tenantId: string,
    integrationId: string,
    limit = 20,
  ): Promise<AccountingSyncLogEntry[]> {
    return this.rows
      .filter((r) => r.tenantId === tenantId && r.integrationId === integrationId)
      .sort((a, b) => b.syncedAt.getTime() - a.syncedAt.getTime())
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }
}

export class InMemoryAccountingOAuthStateRepository implements AccountingOAuthStateRepository {
  private rows = new Map<
    string,
    {
      tenantId: string;
      userId: string;
      provider: AccountingProvider;
      redirectAfter?: string;
      expiresAt: Date;
      consumedAt: Date | null;
    }
  >();

  async create(input: {
    tenantId: string;
    userId: string;
    provider: AccountingProvider;
    redirectAfter?: string;
  }): Promise<{ id: string }> {
    const id = uuidv4();
    this.rows.set(id, {
      ...input,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      consumedAt: null,
    });
    return { id };
  }

  async consume(id: string): Promise<{
    tenantId: string;
    userId: string;
    provider: AccountingProvider;
    redirectAfter?: string;
  } | null> {
    const row = this.rows.get(id);
    if (!row || row.consumedAt || row.expiresAt.getTime() < Date.now()) return null;
    row.consumedAt = new Date();
    this.rows.set(id, row);
    return {
      tenantId: row.tenantId,
      userId: row.userId,
      provider: row.provider,
      redirectAfter: row.redirectAfter,
    };
  }
}

/* ───────────── Pg ───────────── */

function mapIntegration(row: Record<string, unknown>): AccountingIntegration {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    provider: row.provider as AccountingProvider,
    accessTokenEncrypted: row.access_token_encrypted as string,
    refreshTokenEncrypted: row.refresh_token_encrypted as string,
    realmId: row.realm_id as string,
    connectedAt: new Date(row.connected_at as string),
    lastSyncedAt: row.last_synced_at ? new Date(row.last_synced_at as string) : null,
    status: row.status as AccountingIntegrationStatus,
    errorMessage: (row.error_message as string | null) ?? null,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

function mapSyncLog(row: Record<string, unknown>): AccountingSyncLogEntry {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    integrationId: row.integration_id as string,
    entityType: row.entity_type as AccountingSyncEntityType,
    entityId: row.entity_id as string,
    externalId: (row.external_id as string | null) ?? null,
    action: row.action as AccountingSyncAction,
    status: row.status as AccountingSyncStatus,
    payloadHash: row.payload_hash as string,
    errorMessage: (row.error_message as string | null) ?? null,
    syncedAt: new Date(row.synced_at as string),
  };
}

export class PgAccountingIntegrationRepository
  extends PgBaseRepository
  implements AccountingIntegrationRepository
{
  constructor(pool: Pool) {
    super(pool);
  }

  async upsert(input: UpsertAccountingIntegrationInput): Promise<AccountingIntegration> {
    if (!input.tenantId || !input.realmId) {
      throw new ValidationError('tenantId and realmId are required');
    }
    const accessTokenEncrypted = encryptAccountingToken(input.accessToken);
    const refreshTokenEncrypted = encryptAccountingToken(input.refreshToken);
    return this.withTenant(input.tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO accounting_integrations
           (tenant_id, provider, access_token_encrypted, refresh_token_encrypted,
            realm_id, connected_at, status)
         VALUES ($1, $2, $3, $4, $5, NOW(), 'active')
         ON CONFLICT (tenant_id) DO UPDATE SET
           provider = EXCLUDED.provider,
           access_token_encrypted = EXCLUDED.access_token_encrypted,
           refresh_token_encrypted = EXCLUDED.refresh_token_encrypted,
           realm_id = EXCLUDED.realm_id,
           connected_at = NOW(),
           status = 'active',
           error_message = NULL,
           updated_at = NOW()
         RETURNING *`,
        [
          input.tenantId,
          input.provider,
          accessTokenEncrypted,
          refreshTokenEncrypted,
          input.realmId,
        ],
      );
      return mapIntegration(result.rows[0] as Record<string, unknown>);
    });
  }

  async findByTenant(
    tenantId: string,
    provider: AccountingProvider = 'quickbooks',
  ): Promise<AccountingIntegration | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM accounting_integrations
         WHERE tenant_id = $1 AND provider = $2`,
        [tenantId, provider],
      );
      const row = result.rows[0];
      return row ? mapIntegration(row as Record<string, unknown>) : null;
    });
  }

  async findAllActive(): Promise<AccountingIntegration[]> {
    const client = await this.pool.connect();
    try {
      await client.query("SELECT set_config('app.system_lookup', 'true', true)");
      const result = await client.query(
        `SELECT * FROM accounting_integrations WHERE status = 'active'`,
      );
      return result.rows.map((row) => mapIntegration(row as Record<string, unknown>));
    } finally {
      try {
        await client.query("RESET app.system_lookup");
      } catch {
        // ignore — connection release handles broken clients
      }
      client.release();
    }
  }

  async updateLastSyncedAt(tenantId: string, id: string, at: Date): Promise<void> {
    await this.withTenant(tenantId, async (client) => {
      await client.query(
        `UPDATE accounting_integrations SET last_synced_at = $3, updated_at = NOW()
         WHERE tenant_id = $1 AND id = $2`,
        [tenantId, id, at],
      );
    });
  }

  async setStatus(
    tenantId: string,
    id: string,
    status: AccountingIntegrationStatus,
    errorMessage: string | null = null,
  ): Promise<AccountingIntegration | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `UPDATE accounting_integrations
         SET status = $3, error_message = $4, updated_at = NOW()
         WHERE tenant_id = $1 AND id = $2
         RETURNING *`,
        [tenantId, id, status, errorMessage],
      );
      const row = result.rows[0];
      return row ? mapIntegration(row as Record<string, unknown>) : null;
    });
  }

  async updateTokens(
    tenantId: string,
    id: string,
    accessTokenEncrypted: string,
    refreshTokenEncrypted: string,
  ): Promise<AccountingIntegration | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `UPDATE accounting_integrations
         SET access_token_encrypted = $3,
             refresh_token_encrypted = $4,
             status = 'active',
             error_message = NULL,
             updated_at = NOW()
         WHERE tenant_id = $1 AND id = $2
         RETURNING *`,
        [tenantId, id, accessTokenEncrypted, refreshTokenEncrypted],
      );
      const row = result.rows[0];
      return row ? mapIntegration(row as Record<string, unknown>) : null;
    });
  }

  async disconnect(tenantId: string, provider: AccountingProvider): Promise<boolean> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `UPDATE accounting_integrations
         SET status = 'disconnected', updated_at = NOW()
         WHERE tenant_id = $1 AND provider = $2 AND status <> 'disconnected'`,
        [tenantId, provider],
      );
      return (result.rowCount ?? 0) > 0;
    });
  }
}

export class PgAccountingSyncLogRepository
  extends PgBaseRepository
  implements AccountingSyncLogRepository
{
  constructor(pool: Pool) {
    super(pool);
  }

  async create(input: CreateAccountingSyncLogInput): Promise<AccountingSyncLogEntry> {
    return this.withTenant(input.tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO accounting_sync_log
           (tenant_id, integration_id, entity_type, entity_id, external_id,
            action, status, payload_hash, error_message)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [
          input.tenantId,
          input.integrationId,
          input.entityType,
          input.entityId,
          input.externalId ?? null,
          input.action,
          input.status,
          input.payloadHash,
          input.errorMessage ?? null,
        ],
      );
      return mapSyncLog(result.rows[0] as Record<string, unknown>);
    });
  }

  async findSuccessfulPush(
    tenantId: string,
    integrationId: string,
    entityType: AccountingSyncEntityType,
    entityId: string,
    payloadHash: string,
  ): Promise<AccountingSyncLogEntry | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM accounting_sync_log
         WHERE tenant_id = $1 AND integration_id = $2
           AND entity_type = $3 AND entity_id = $4
           AND payload_hash = $5 AND status = 'success' AND action = 'push'
         LIMIT 1`,
        [tenantId, integrationId, entityType, entityId, payloadHash],
      );
      const row = result.rows[0];
      return row ? mapSyncLog(row as Record<string, unknown>) : null;
    });
  }

  async findExternalIdForEntity(
    tenantId: string,
    integrationId: string,
    entityType: AccountingSyncEntityType,
    entityId: string,
  ): Promise<string | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT external_id FROM accounting_sync_log
         WHERE tenant_id = $1 AND integration_id = $2
           AND entity_type = $3 AND entity_id = $4
           AND status = 'success' AND external_id IS NOT NULL
         ORDER BY synced_at DESC
         LIMIT 1`,
        [tenantId, integrationId, entityType, entityId],
      );
      return (result.rows[0]?.external_id as string | undefined) ?? null;
    });
  }

  async countRecentFailures(
    tenantId: string,
    integrationId: string,
    since: Date,
  ): Promise<number> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT COUNT(*)::int AS cnt FROM accounting_sync_log
         WHERE tenant_id = $1 AND integration_id = $2
           AND status = 'failed' AND synced_at >= $3`,
        [tenantId, integrationId, since],
      );
      return (result.rows[0]?.cnt as number) ?? 0;
    });
  }

  async listRecent(
    tenantId: string,
    integrationId: string,
    limit = 20,
  ): Promise<AccountingSyncLogEntry[]> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM accounting_sync_log
         WHERE tenant_id = $1 AND integration_id = $2
         ORDER BY synced_at DESC
         LIMIT $3`,
        [tenantId, integrationId, limit],
      );
      return result.rows.map((row) => mapSyncLog(row as Record<string, unknown>));
    });
  }
}

export class PgAccountingOAuthStateRepository implements AccountingOAuthStateRepository {
  constructor(private readonly pool: Pool) {}

  async create(input: {
    tenantId: string;
    userId: string;
    provider: AccountingProvider;
    redirectAfter?: string;
  }): Promise<{ id: string }> {
    const result = await this.pool.query(
      `INSERT INTO oauth_states (tenant_id, user_id, provider, redirect_after)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [input.tenantId, input.userId, input.provider, input.redirectAfter ?? null],
    );
    return { id: result.rows[0].id as string };
  }

  async consume(id: string): Promise<{
    tenantId: string;
    userId: string;
    provider: AccountingProvider;
    redirectAfter?: string;
  } | null> {
    const result = await this.pool.query(
      `UPDATE oauth_states
       SET consumed_at = NOW()
       WHERE id = $1
         AND consumed_at IS NULL
         AND expires_at > NOW()
         AND provider IN ('quickbooks', 'xero')
       RETURNING tenant_id, user_id, provider, redirect_after`,
      [id],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      tenantId: row.tenant_id as string,
      userId: row.user_id as string,
      provider: row.provider as AccountingProvider,
      redirectAfter: (row.redirect_after as string | null) ?? undefined,
    };
  }
}

export function decryptedAccessToken(integration: AccountingIntegration): string {
  return decryptAccountingToken(integration.accessTokenEncrypted);
}

export function decryptedRefreshToken(integration: AccountingIntegration): string {
  return decryptAccountingToken(integration.refreshTokenEncrypted);
}
