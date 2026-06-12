/**
 * Rivet P2 F-1 — supervisor_policies repository (migration 167).
 *
 * Versioned per-tenant rule sets. `createVersion` appends an INACTIVE
 * version; `activate` flips exactly one version on (and every sibling
 * off) inside a single transaction, so `getActive` always sees at most
 * one active row per tenant. No active row → the caller falls back to
 * DEFAULT_SUPERVISOR_RULES (permissive parity).
 *
 * Settings/API exposure of these mutations is deferred (no routes in
 * this track) — see service.ts header.
 */
import { Pool } from 'pg';
import { PgBaseRepository } from '../../db/pg-base';
import { SupervisorRules } from './policy';

export interface SupervisorPolicyRecord {
  id: string;
  tenantId: string;
  version: number;
  active: boolean;
  rules: SupervisorRules;
  createdBy?: string;
  createdAt: Date;
}

export interface SupervisorPolicyRepository {
  /** The single active rule set for the tenant, or null (= permissive defaults). */
  getActive(tenantId: string): Promise<SupervisorPolicyRecord | null>;
  /** Append a new INACTIVE version (version = max(tenant versions) + 1). */
  createVersion(
    tenantId: string,
    rules: SupervisorRules,
    createdBy?: string,
  ): Promise<SupervisorPolicyRecord>;
  /**
   * Activate `version` and deactivate every other version for the
   * tenant, atomically. Returns the activated record, or null when the
   * version does not exist (no state change).
   */
  activate(tenantId: string, version: number): Promise<SupervisorPolicyRecord | null>;
}

interface SupervisorPolicyRow {
  id: string;
  tenant_id: string;
  version: number;
  active: boolean;
  rules: SupervisorRules;
  created_by: string | null;
  created_at: string | Date;
}

function mapRow(row: SupervisorPolicyRow): SupervisorPolicyRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    version: row.version,
    active: row.active,
    rules: row.rules ?? {},
    createdBy: row.created_by ?? undefined,
    createdAt: new Date(row.created_at),
  };
}

export class PgSupervisorPolicyRepository
  extends PgBaseRepository
  implements SupervisorPolicyRepository
{
  constructor(pool: Pool) {
    super(pool);
  }

  async getActive(tenantId: string): Promise<SupervisorPolicyRecord | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT id, tenant_id, version, active, rules, created_by, created_at
           FROM supervisor_policies
          WHERE tenant_id = $1 AND active = true
          ORDER BY version DESC
          LIMIT 1`,
        [tenantId],
      );
      return result.rows.length > 0 ? mapRow(result.rows[0] as SupervisorPolicyRow) : null;
    });
  }

  async createVersion(
    tenantId: string,
    rules: SupervisorRules,
    createdBy?: string,
  ): Promise<SupervisorPolicyRecord> {
    // Next-version computed in the INSERT itself; a concurrent
    // createVersion for the same tenant trips UNIQUE(tenant_id, version)
    // rather than silently double-assigning (admin-rate operation, so a
    // retry-on-conflict burden on the caller is acceptable).
    return this.withTenantTransaction(tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO supervisor_policies (tenant_id, version, active, rules, created_by)
         SELECT $1, COALESCE(MAX(version), 0) + 1, false, $2::jsonb, $3
           FROM supervisor_policies
          WHERE tenant_id = $1
         RETURNING id, tenant_id, version, active, rules, created_by, created_at`,
        [tenantId, JSON.stringify(rules), createdBy ?? null],
      );
      return mapRow(result.rows[0] as SupervisorPolicyRow);
    });
  }

  async activate(tenantId: string, version: number): Promise<SupervisorPolicyRecord | null> {
    return this.withTenantTransaction(tenantId, async (client) => {
      const activated = await client.query(
        `UPDATE supervisor_policies
            SET active = true
          WHERE tenant_id = $1 AND version = $2
         RETURNING id, tenant_id, version, active, rules, created_by, created_at`,
        [tenantId, version],
      );
      if (activated.rows.length === 0) {
        // Unknown version: no state change (the deactivate below never ran).
        return null;
      }
      await client.query(
        `UPDATE supervisor_policies
            SET active = false
          WHERE tenant_id = $1 AND version <> $2 AND active = true`,
        [tenantId, version],
      );
      return mapRow(activated.rows[0] as SupervisorPolicyRow);
    });
  }
}

export class InMemorySupervisorPolicyRepository implements SupervisorPolicyRepository {
  private byTenant = new Map<string, SupervisorPolicyRecord[]>();
  private nextId = 1;

  async getActive(tenantId: string): Promise<SupervisorPolicyRecord | null> {
    const records = this.byTenant.get(tenantId) ?? [];
    const active = records.filter((r) => r.active).sort((a, b) => b.version - a.version)[0];
    return active ? { ...active, rules: { ...active.rules } } : null;
  }

  async createVersion(
    tenantId: string,
    rules: SupervisorRules,
    createdBy?: string,
  ): Promise<SupervisorPolicyRecord> {
    const records = this.byTenant.get(tenantId) ?? [];
    const version = records.reduce((max, r) => Math.max(max, r.version), 0) + 1;
    const record: SupervisorPolicyRecord = {
      id: `supervisor-policy-${this.nextId++}`,
      tenantId,
      version,
      active: false,
      rules: { ...rules },
      createdBy,
      createdAt: new Date(),
    };
    this.byTenant.set(tenantId, [...records, record]);
    return { ...record, rules: { ...record.rules } };
  }

  async activate(tenantId: string, version: number): Promise<SupervisorPolicyRecord | null> {
    const records = this.byTenant.get(tenantId) ?? [];
    const target = records.find((r) => r.version === version);
    if (!target) return null;
    for (const r of records) r.active = r.version === version;
    return { ...target, rules: { ...target.rules } };
  }
}
