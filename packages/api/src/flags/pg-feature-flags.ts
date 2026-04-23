import { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import { FeatureFlag, FeatureFlagRepository } from './feature-flags';

/**
 * P7-015 — Postgres-backed feature flag persistence.
 *
 * Tenant-independent by design: feature flags gate features across the
 * whole app, not per-tenant data rows (per-tenant enablement is expressed
 * via the optional `tenant_ids` column). No RLS context is set — the
 * admin-only router guards write access at the HTTP layer.
 */
export class PgFeatureFlagRepository
  extends PgBaseRepository
  implements FeatureFlagRepository
{
  private initPromise?: Promise<void>;

  constructor(pool: Pool) {
    super(pool);
  }

  private async ensureTable(client: import('pg').PoolClient): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      await client.query(`
        CREATE TABLE IF NOT EXISTS _feature_flags (
          name TEXT PRIMARY KEY,
          enabled BOOLEAN NOT NULL,
          environments TEXT[] NULL,
          tenant_ids TEXT[] NULL,
          description TEXT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
    })();
    try {
      await this.initPromise;
    } catch (err) {
      this.initPromise = undefined;
      throw err;
    }
  }

  async list(): Promise<FeatureFlag[]> {
    return this.withClient(async (client) => {
      await this.ensureTable(client);
      const result = await client.query(
        `SELECT name, enabled, environments, tenant_ids, description
         FROM _feature_flags
         ORDER BY name ASC`
      );
      return result.rows.map((row) => rowToFlag(row));
    });
  }

  async get(name: string): Promise<FeatureFlag | null> {
    return this.withClient(async (client) => {
      await this.ensureTable(client);
      const result = await client.query(
        `SELECT name, enabled, environments, tenant_ids, description
         FROM _feature_flags WHERE name = $1`,
        [name]
      );
      if (result.rows.length === 0) return null;
      return rowToFlag(result.rows[0]);
    });
  }

  async upsert(flag: FeatureFlag): Promise<FeatureFlag> {
    if (!flag.name || flag.name.trim().length === 0) {
      throw new Error('Flag name is required');
    }
    return this.withClient(async (client) => {
      await this.ensureTable(client);
      const result = await client.query(
        `INSERT INTO _feature_flags (name, enabled, environments, tenant_ids, description, updated_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (name) DO UPDATE SET
           enabled = EXCLUDED.enabled,
           environments = EXCLUDED.environments,
           tenant_ids = EXCLUDED.tenant_ids,
           description = EXCLUDED.description,
           updated_at = NOW()
         RETURNING name, enabled, environments, tenant_ids, description`,
        [
          flag.name,
          flag.enabled,
          flag.environments ?? null,
          flag.tenantIds ?? null,
          flag.description ?? null,
        ]
      );
      return rowToFlag(result.rows[0]);
    });
  }

  async delete(name: string): Promise<boolean> {
    return this.withClient(async (client) => {
      await this.ensureTable(client);
      const result = await client.query(
        `DELETE FROM _feature_flags WHERE name = $1`,
        [name]
      );
      return (result.rowCount ?? 0) > 0;
    });
  }
}

function rowToFlag(row: {
  name: string;
  enabled: boolean;
  environments: string[] | null;
  tenant_ids: string[] | null;
  description: string | null;
}): FeatureFlag {
  return {
    name: row.name,
    enabled: row.enabled,
    environments: row.environments ?? undefined,
    tenantIds: row.tenant_ids ?? undefined,
    description: row.description ?? undefined,
  };
}
