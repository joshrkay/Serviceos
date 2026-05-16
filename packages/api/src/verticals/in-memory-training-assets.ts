import type {
  PrivacyAuditEntry,
  PrivacyAuditRepository,
  TrainingAssetListOptions,
  TrainingAssetListPage,
  TrainingAssetRepository,
  TryUpdateResult,
  VerticalTrainingAsset,
} from './training-assets';
import type { VerticalType } from '../shared/vertical-types';

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

export class InMemoryTrainingAssetRepository implements TrainingAssetRepository {
  private readonly rows = new Map<string, VerticalTrainingAsset>();

  async save(asset: VerticalTrainingAsset): Promise<VerticalTrainingAsset> {
    const existing = this.rows.get(asset.id);
    if (existing && existing.tenantId !== asset.tenantId) {
      throw new Error('training asset id belongs to another tenant');
    }
    this.rows.set(asset.id, asset);
    return asset;
  }

  async tryUpdate(
    asset: VerticalTrainingAsset,
    expectedUpdatedAt: Date,
  ): Promise<TryUpdateResult> {
    const existing = this.rows.get(asset.id);
    if (!existing || existing.tenantId !== asset.tenantId) return { kind: 'missing' };
    if (existing.updatedAt.getTime() !== expectedUpdatedAt.getTime()) {
      return { kind: 'stale' };
    }
    this.rows.set(asset.id, asset);
    return { kind: 'updated', asset };
  }

  async delete(tenantId: string, id: string): Promise<void> {
    const existing = this.rows.get(id);
    if (existing?.tenantId === tenantId) {
      this.rows.delete(id);
    }
  }

  async findById(tenantId: string, id: string): Promise<VerticalTrainingAsset | null> {
    const row = this.rows.get(id);
    if (!row || row.tenantId !== tenantId) return null;
    return row;
  }

  async findByIdempotencyKey(
    tenantId: string,
    idempotencyKey: string,
  ): Promise<VerticalTrainingAsset | null> {
    for (const row of this.rows.values()) {
      if (row.tenantId === tenantId && row.idempotencyKey === idempotencyKey) {
        return row;
      }
    }
    return null;
  }

  async listByTenant(
    tenantId: string,
    options: TrainingAssetListOptions = {},
  ): Promise<TrainingAssetListPage> {
    const all = [...this.rows.values()]
      .filter((row) => row.tenantId === tenantId)
      .sort((left, right) => {
        const diff = right.updatedAt.getTime() - left.updatedAt.getTime();
        return diff !== 0 ? diff : left.id.localeCompare(right.id);
      });
    const limit = normalizePaginationLimit(options.limit);
    const offset = normalizePaginationOffset(options.offset);
    return {
      data: all.slice(offset, offset + limit),
      total: all.length,
      limit,
      offset,
    };
  }

  async listActiveByTenantAndVertical(
    tenantId: string,
    verticalType: VerticalType,
    limit?: number,
  ): Promise<VerticalTrainingAsset[]> {
    const rows = [...this.rows.values()]
      .filter(
        (row) =>
          row.tenantId === tenantId &&
          row.verticalType === verticalType &&
          row.status === 'active',
      )
      .sort((left, right) => {
        const updatedDiff = right.updatedAt.getTime() - left.updatedAt.getTime();
        return updatedDiff !== 0 ? updatedDiff : left.id.localeCompare(right.id);
      });
    return limit === undefined ? rows : rows.slice(0, normalizeActiveListLimit(limit));
  }
}

function normalizeActiveListLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 1;
  return Math.min(50, Math.max(1, Math.floor(limit)));
}

function normalizePaginationLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIST_LIMIT;
  return Math.min(MAX_LIST_LIMIT, Math.max(1, Math.floor(limit)));
}

function normalizePaginationOffset(offset: number | undefined): number {
  if (offset === undefined || !Number.isFinite(offset)) return 0;
  return Math.max(0, Math.floor(offset));
}

export class InMemoryPrivacyAuditRepository implements PrivacyAuditRepository {
  readonly rows: PrivacyAuditEntry[] = [];

  async create(entry: PrivacyAuditEntry): Promise<PrivacyAuditEntry> {
    this.rows.push(entry);
    return entry;
  }

  async delete(tenantId: string, id: string): Promise<void> {
    const index = this.rows.findIndex((row) => row.tenantId === tenantId && row.id === id);
    if (index >= 0) {
      this.rows.splice(index, 1);
    }
  }
}
