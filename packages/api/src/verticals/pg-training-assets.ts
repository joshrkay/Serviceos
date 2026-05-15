import type { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import type { VerticalType } from '../shared/vertical-types';
import type {
  PrivacyAuditEntry,
  PrivacyAuditRepository,
  TrainingAssetRepository,
  VerticalTrainingAsset,
} from './training-assets';

function jsonValue<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') return JSON.parse(value) as T;
  return value as T;
}

function rowToAsset(row: Record<string, unknown>): VerticalTrainingAsset {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    verticalType: row.vertical_type as VerticalType,
    assetKind: row.asset_kind as VerticalTrainingAsset['assetKind'],
    status: row.status as VerticalTrainingAsset['status'],
    title: String(row.title),
    rawText: row.raw_text === null || row.raw_text === undefined ? undefined : String(row.raw_text),
    scrubbedText: row.scrubbed_text === null || row.scrubbed_text === undefined ? undefined : String(row.scrubbed_text),
    labels: jsonValue(row.labels, {}) as VerticalTrainingAsset['labels'],
    provenance: jsonValue(row.provenance, {}) as VerticalTrainingAsset['provenance'],
    redactionSummary: row.redaction_summary
      ? jsonValue(row.redaction_summary, undefined) as VerticalTrainingAsset['redactionSummary']
      : undefined,
    createdBy: String(row.created_by),
    approvedBy: row.approved_by === null || row.approved_by === undefined ? undefined : String(row.approved_by),
    activatedAt: row.activated_at ? new Date(String(row.activated_at)) : undefined,
    createdAt: new Date(String(row.created_at)),
    updatedAt: new Date(String(row.updated_at)),
  };
}

function rowToPrivacyAuditEntry(row: Record<string, unknown>): PrivacyAuditEntry {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    actorId: String(row.actor_id),
    entityType: row.entity_type as PrivacyAuditEntry['entityType'],
    entityId: String(row.entity_id),
    operation: row.operation as PrivacyAuditEntry['operation'],
    redactionSummary: jsonValue(row.redaction_summary, {}) as PrivacyAuditEntry['redactionSummary'],
    redactions: jsonValue(row.redactions, []) as PrivacyAuditEntry['redactions'],
    createdAt: new Date(String(row.created_at)),
  };
}

export class PgTrainingAssetRepository extends PgBaseRepository implements TrainingAssetRepository {
  constructor(pool: Pool) {
    super(pool);
  }

  async save(asset: VerticalTrainingAsset): Promise<VerticalTrainingAsset> {
    return this.withTenant(asset.tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO vertical_training_assets (
          id, tenant_id, vertical_type, asset_kind, status, title,
          raw_text, scrubbed_text, labels, provenance, redaction_summary,
          created_by, approved_by, activated_at, created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6,
          $7, $8, $9, $10, $11,
          $12, $13, $14, $15, $16
        )
        ON CONFLICT (id) DO UPDATE SET
          vertical_type = EXCLUDED.vertical_type,
          asset_kind = EXCLUDED.asset_kind,
          status = EXCLUDED.status,
          title = EXCLUDED.title,
          raw_text = EXCLUDED.raw_text,
          scrubbed_text = EXCLUDED.scrubbed_text,
          labels = EXCLUDED.labels,
          provenance = EXCLUDED.provenance,
          redaction_summary = EXCLUDED.redaction_summary,
          created_by = EXCLUDED.created_by,
          approved_by = EXCLUDED.approved_by,
          activated_at = EXCLUDED.activated_at,
          created_at = EXCLUDED.created_at,
          updated_at = EXCLUDED.updated_at
        WHERE vertical_training_assets.tenant_id = EXCLUDED.tenant_id
        RETURNING *`,
        [
          asset.id,
          asset.tenantId,
          asset.verticalType,
          asset.assetKind,
          asset.status,
          asset.title,
          asset.rawText ?? null,
          asset.scrubbedText ?? null,
          JSON.stringify(asset.labels),
          JSON.stringify(asset.provenance),
          asset.redactionSummary ? JSON.stringify(asset.redactionSummary) : null,
          asset.createdBy,
          asset.approvedBy ?? null,
          asset.activatedAt ?? null,
          asset.createdAt,
          asset.updatedAt,
        ],
      );
      if (result.rows.length === 0) {
        throw new Error('training asset id belongs to another tenant');
      }
      return rowToAsset(result.rows[0]);
    });
  }

  async findById(tenantId: string, id: string): Promise<VerticalTrainingAsset | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM vertical_training_assets
         WHERE tenant_id = $1 AND id = $2
         LIMIT 1`,
        [tenantId, id],
      );
      return result.rows.length > 0 ? rowToAsset(result.rows[0]) : null;
    });
  }

  async listByTenant(tenantId: string): Promise<VerticalTrainingAsset[]> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM vertical_training_assets
         WHERE tenant_id = $1
         ORDER BY updated_at DESC`,
        [tenantId],
      );
      return result.rows.map(rowToAsset);
    });
  }

  async listActiveByTenantAndVertical(
    tenantId: string,
    verticalType: VerticalType,
    limit?: number,
  ): Promise<VerticalTrainingAsset[]> {
    return this.withTenant(tenantId, async (client) => {
      const normalizedLimit = normalizeListLimit(limit);
      const values: unknown[] = [tenantId, verticalType];
      if (normalizedLimit !== undefined) {
        values.push(normalizedLimit);
      }
      const result = await client.query(
        `SELECT * FROM vertical_training_assets
         WHERE tenant_id = $1 AND vertical_type = $2 AND status = 'active'
         ORDER BY updated_at DESC${normalizedLimit === undefined ? '' : '\n         LIMIT $3'}`,
        values,
      );
      return result.rows.map(rowToAsset);
    });
  }
}

function normalizeListLimit(limit: number | undefined): number | undefined {
  if (limit === undefined) return undefined;
  if (!Number.isFinite(limit)) return 1;
  return Math.min(50, Math.max(1, Math.floor(limit)));
}

export class PgPrivacyAuditRepository extends PgBaseRepository implements PrivacyAuditRepository {
  constructor(pool: Pool) {
    super(pool);
  }

  async create(entry: PrivacyAuditEntry): Promise<PrivacyAuditEntry> {
    return this.withTenant(entry.tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO privacy_audit (
          id, tenant_id, actor_id, entity_type, entity_id, operation,
          redaction_summary, redactions, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING *`,
        [
          entry.id,
          entry.tenantId,
          entry.actorId,
          entry.entityType,
          entry.entityId,
          entry.operation,
          JSON.stringify(entry.redactionSummary),
          JSON.stringify(entry.redactions),
          entry.createdAt,
        ],
      );
      return rowToPrivacyAuditEntry(result.rows[0]);
    });
  }
}
