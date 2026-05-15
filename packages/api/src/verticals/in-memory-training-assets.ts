import type {
  PrivacyAuditEntry,
  PrivacyAuditRepository,
  TrainingAssetRepository,
  VerticalTrainingAsset,
} from './training-assets';
import type { VerticalType } from '../shared/vertical-types';

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

  async listByTenant(tenantId: string): Promise<VerticalTrainingAsset[]> {
    return [...this.rows.values()].filter((row) => row.tenantId === tenantId);
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
    return limit === undefined ? rows : rows.slice(0, normalizeListLimit(limit));
  }
}

function normalizeListLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 1;
  return Math.min(50, Math.max(1, Math.floor(limit)));
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
