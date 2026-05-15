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
  ): Promise<VerticalTrainingAsset[]> {
    return [...this.rows.values()].filter(
      (row) =>
        row.tenantId === tenantId &&
        row.verticalType === verticalType &&
        row.status === 'active',
    );
  }
}

export class InMemoryPrivacyAuditRepository implements PrivacyAuditRepository {
  readonly rows: PrivacyAuditEntry[] = [];

  async create(entry: PrivacyAuditEntry): Promise<PrivacyAuditEntry> {
    this.rows.push(entry);
    return entry;
  }
}
