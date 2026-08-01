/**
 * N-011 / P4-015 — Postgres brand-voice repository.
 *
 * Reads/writes the `brand_voice` JSONB + the migration-238 bookkeeping columns
 * on `tenant_settings`, and the append-only `brand_voice_versions` history
 * table (migration 237). `bumpVersion` is a single atomic write: it locks the
 * settings row, inserts the next snapshot, and updates the blob + bookkeeping
 * columns together. Under a request transaction (withTenantTransaction) it
 * reuses that client, so the whole PUT commits/rolls back as one unit.
 */
import { Pool } from 'pg';
import { PgBaseRepository } from '../../db/pg-base';
import type { BrandVoiceSettings } from '../../settings/settings';
import {
  resolveBumpDecision,
  type BrandVoiceRepository,
  type BrandVoiceState,
  type BrandVoiceVersionRow,
  type BrandVoiceChangeReason,
  type BrandVoiceMutation,
  type BrandVoiceBumpResult,
} from './brand-voice';

function toConfig(raw: unknown): BrandVoiceSettings {
  if (!raw || typeof raw !== 'object') return {};
  return raw as BrandVoiceSettings;
}

function toIso(value: unknown): string | null {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

export class PgBrandVoiceRepository
  extends PgBaseRepository
  implements BrandVoiceRepository
{
  constructor(pool: Pool) {
    super(pool);
  }

  async getState(tenantId: string): Promise<BrandVoiceState> {
    return this.withTenant(tenantId, async (client) => {
      const res = await client.query(
        `SELECT brand_voice, brand_voice_version, brand_voice_locked, brand_voice_updated_at
           FROM tenant_settings WHERE tenant_id = $1`,
        [tenantId],
      );
      if (res.rowCount === 0) {
        return { config: {}, version: 0, locked: false, updatedAt: null };
      }
      const row = res.rows[0];
      return {
        config: toConfig(row.brand_voice),
        version: (row.brand_voice_version as number | null) ?? 0,
        locked: (row.brand_voice_locked as boolean | null) ?? false,
        updatedAt: toIso(row.brand_voice_updated_at),
      };
    });
  }

  async listVersions(tenantId: string): Promise<BrandVoiceVersionRow[]> {
    return this.withTenant(tenantId, async (client) => {
      const res = await client.query(
        `SELECT version, snapshot, changed_by, change_reason, created_at
           FROM brand_voice_versions
          WHERE tenant_id = $1
          ORDER BY version DESC`,
        [tenantId],
      );
      return res.rows.map((row) => ({
        version: row.version as number,
        snapshot: toConfig(row.snapshot),
        changedBy: (row.changed_by as string | null) ?? null,
        changeReason: row.change_reason as BrandVoiceChangeReason,
        createdAt: toIso(row.created_at) ?? '',
      }));
    });
  }

  async getVersionSnapshot(
    tenantId: string,
    version: number,
  ): Promise<BrandVoiceSettings | null> {
    return this.withTenant(tenantId, async (client) => {
      const res = await client.query(
        `SELECT snapshot FROM brand_voice_versions
          WHERE tenant_id = $1 AND version = $2`,
        [tenantId, version],
      );
      if (res.rowCount === 0) return null;
      return toConfig(res.rows[0].snapshot);
    });
  }

  async bumpVersion(
    tenantId: string,
    args: {
      mutation: BrandVoiceMutation;
      changedBy: string | null;
      now: number;
    },
  ): Promise<BrandVoiceBumpResult> {
    return this.withTenant(tenantId, async (client) => {
      // Lock the settings row and re-read the FULL current state under the
      // lock. This both prevents a concurrent bump from minting a duplicate
      // (tenant_id, version) — the UNIQUE constraint would otherwise 23505 —
      // AND makes the cool-down check + merge atomic with the write, so two
      // overlapping saves can't merge on stale config or double-bypass the
      // cool-down (TOCTOU fix).
      const cur = await client.query(
        `SELECT brand_voice, brand_voice_version, brand_voice_locked, brand_voice_updated_at
           FROM tenant_settings WHERE tenant_id = $1 FOR UPDATE`,
        [tenantId],
      );
      if (cur.rowCount === 0) {
        throw new Error(`tenant_settings row missing for tenant ${tenantId}`);
      }
      const row = cur.rows[0];
      const current: BrandVoiceState = {
        config: toConfig(row.brand_voice),
        version: (row.brand_voice_version as number | null) ?? 0,
        locked: (row.brand_voice_locked as boolean | null) ?? false,
        updatedAt: toIso(row.brand_voice_updated_at),
      };

      // Cool-down precondition + merge, decided against the locked state.
      // Throws BrandVoiceCooldownError (→ 423) inside the window.
      const decision = resolveBumpDecision(current, args.mutation, args.now);
      const nextVersion = current.version + 1;
      // The persisted anchor uses the same `now` the cool-down decision used —
      // no clock drift between the gate and the stored timestamp.
      const updatedAtIso = new Date(args.now).toISOString();
      const configJson = JSON.stringify(decision.nextConfig);

      await client.query(
        `INSERT INTO brand_voice_versions
           (tenant_id, version, snapshot, changed_by, change_reason)
         VALUES ($1, $2, $3::jsonb, $4, $5)`,
        [tenantId, nextVersion, configJson, args.changedBy, decision.changeReason],
      );

      const upd = await client.query(
        `UPDATE tenant_settings
            SET brand_voice = $2::jsonb,
                brand_voice_version = $3,
                brand_voice_locked = true,
                brand_voice_updated_at = $4::timestamptz
          WHERE tenant_id = $1
        RETURNING brand_voice_updated_at`,
        [tenantId, configJson, nextVersion, updatedAtIso],
      );

      return {
        state: {
          config: decision.nextConfig,
          version: nextVersion,
          locked: true,
          updatedAt: toIso(upd.rows[0].brand_voice_updated_at),
        },
        fromVersion: decision.fromVersion,
        changedFields: decision.changedFields,
        changeReason: decision.changeReason,
      };
    });
  }
}
