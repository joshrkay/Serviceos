import type { Pool, PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import {
  InMemoryPrivacyAuditRepository,
  InMemoryTrainingAssetRepository,
} from '../../src/verticals/in-memory-training-assets';
import {
  PgPrivacyAuditRepository,
  PgTrainingAssetRepository,
} from '../../src/verticals/pg-training-assets';
import { TrainingAssetRedactionService } from '../../src/verticals/training-asset-redaction';
import { TrainingAssetService } from '../../src/verticals/training-asset-service';
import type { PrivacyAuditEntry, VerticalTrainingAsset } from '../../src/verticals/training-assets';

vi.mock('../../src/db/schema', () => ({
  setTenantContext: (tenantId: string) => `SET app.current_tenant_id = '${tenantId}'`,
}));

function makeAsset(overrides: Partial<VerticalTrainingAsset> = {}): VerticalTrainingAsset {
  const now = new Date('2026-05-15T00:00:00Z');
  return {
    id: 'asset-1',
    tenantId: 'tenant-1',
    verticalType: 'hvac',
    assetKind: 'rag_seed',
    status: 'active',
    title: 'No heat triage',
    rawText: 'Ask if no heat is affecting the whole home.',
    scrubbedText: 'Ask if no heat is affecting the whole home.',
    labels: { intent: 'emergency_dispatch' },
    provenance: { source: 'tenant_admin', sourceVersion: '1' },
    createdBy: 'user-1',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makePrivacyAuditEntry(overrides: Partial<PrivacyAuditEntry> = {}): PrivacyAuditEntry {
  return {
    id: 'audit-1',
    tenantId: 'tenant-1',
    actorId: 'user-1',
    entityType: 'vertical_training_asset',
    entityId: 'asset-1',
    operation: 'redact_training_asset',
    redactionSummary: {
      redactionCount: 1,
      redactionKinds: ['phone'],
      placeholders: ['[PHONE_1]'],
      residualSignals: [],
      hasResidualPii: false,
    },
    redactions: [{ kind: 'phone', placeholder: '[PHONE_1]', start: 0, end: 9 }],
    createdAt: new Date('2026-05-15T00:00:00Z'),
    ...overrides,
  };
}

type TrainingAssetRow = {
  id: string;
  tenant_id: string;
  vertical_type: string;
  asset_kind: string;
  status: string;
  title: string;
  raw_text: string | null;
  scrubbed_text: string | null;
  labels: string;
  provenance: string;
  redaction_summary: string | null;
  created_by: string;
  approved_by: string | null;
  activated_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

type PrivacyAuditRow = {
  id: string;
  tenant_id: string;
  actor_id: string;
  entity_type: string;
  entity_id: string;
  operation: string;
  redaction_summary: string;
  redactions: string;
  created_at: Date;
};

type RecordedQuery = {
  sql: string;
  values: unknown[];
};

class FakeTrainingAssetClient {
  readonly rows = new Map<string, TrainingAssetRow>();
  readonly privacyAuditRows: PrivacyAuditRow[] = [];
  readonly queries: RecordedQuery[] = [];
  readonly tenantContexts: string[] = [];
  releaseCount = 0;

  async query(sql: string, values: unknown[] = []): Promise<{ rows: Array<TrainingAssetRow | PrivacyAuditRow> }> {
    const normalizedSql = sql.replace(/\s+/g, ' ').trim();
    this.queries.push({ sql: normalizedSql, values });

    if (normalizedSql.startsWith('SET app.current_tenant_id')) {
      const tenantId = normalizedSql.match(/'([^']+)'/)?.[1];
      if (tenantId) this.tenantContexts.push(tenantId);
      return { rows: [] };
    }

    if (normalizedSql.startsWith('INSERT INTO vertical_training_assets')) {
      const row: TrainingAssetRow = {
        id: String(values[0]),
        tenant_id: String(values[1]),
        vertical_type: String(values[2]),
        asset_kind: String(values[3]),
        status: String(values[4]),
        title: String(values[5]),
        raw_text: values[6] === null ? null : String(values[6]),
        scrubbed_text: values[7] === null ? null : String(values[7]),
        labels: String(values[8]),
        provenance: String(values[9]),
        redaction_summary: values[10] === null ? null : String(values[10]),
        created_by: String(values[11]),
        approved_by: values[12] === null ? null : String(values[12]),
        activated_at: values[13] instanceof Date ? values[13] : null,
        created_at: values[14] as Date,
        updated_at: values[15] as Date,
      };
      const existing = this.rows.get(row.id);
      if (existing && existing.tenant_id !== row.tenant_id) {
        return { rows: [] };
      }
      this.rows.set(row.id, row);
      return { rows: [row] };
    }

    if (normalizedSql.startsWith('INSERT INTO privacy_audit')) {
      const row: PrivacyAuditRow = {
        id: String(values[0]),
        tenant_id: String(values[1]),
        actor_id: String(values[2]),
        entity_type: String(values[3]),
        entity_id: String(values[4]),
        operation: String(values[5]),
        redaction_summary: String(values[6]),
        redactions: String(values[7]),
        created_at: values[8] as Date,
      };
      this.privacyAuditRows.push(row);
      return { rows: [row] };
    }

    if (
      normalizedSql.startsWith('SELECT * FROM vertical_training_assets') &&
      normalizedSql.includes('AND id = $2')
    ) {
      const row = this.rows.get(String(values[1]));
      return { rows: row && row.tenant_id === values[0] ? [row] : [] };
    }

    if (
      normalizedSql.startsWith('SELECT * FROM vertical_training_assets') &&
      normalizedSql.includes("status = 'active'")
    ) {
      return {
        rows: this.sortedRows().filter(
          (row) =>
            row.tenant_id === values[0] &&
            row.vertical_type === values[1] &&
            row.status === 'active',
        ),
      };
    }

    if (normalizedSql.startsWith('SELECT * FROM vertical_training_assets')) {
      return {
        rows: this.sortedRows().filter((row) => row.tenant_id === values[0]),
      };
    }

    throw new Error(`Unsupported query: ${normalizedSql}`);
  }

  release(): void {
    this.releaseCount += 1;
  }

  private sortedRows(): TrainingAssetRow[] {
    return [...this.rows.values()].sort(
      (left, right) => right.updated_at.getTime() - left.updated_at.getTime(),
    );
  }
}

class FakeTrainingAssetPool {
  readonly client = new FakeTrainingAssetClient();
  connectCount = 0;

  async connect(): Promise<PoolClient> {
    this.connectCount += 1;
    return this.client as unknown as PoolClient;
  }
}

class RecordingTrainingAssetRepository extends InMemoryTrainingAssetRepository {
  readonly savedAssets: VerticalTrainingAsset[] = [];

  async save(asset: VerticalTrainingAsset): Promise<VerticalTrainingAsset> {
    this.savedAssets.push({ ...asset });
    return super.save(asset);
  }
}

describe('TrainingAssetRepository', () => {
  it('lists active assets by tenant and vertical only', async () => {
    const repo = new InMemoryTrainingAssetRepository();
    await repo.save(makeAsset({ id: 'asset-1', tenantId: 'tenant-1', verticalType: 'hvac' }));
    await repo.save(makeAsset({ id: 'asset-2', tenantId: 'tenant-2', verticalType: 'hvac' }));
    await repo.save(makeAsset({ id: 'asset-3', tenantId: 'tenant-1', verticalType: 'plumbing' }));
    await repo.save(makeAsset({ id: 'asset-4', tenantId: 'tenant-1', verticalType: 'hvac', status: 'draft' }));

    const active = await repo.listActiveByTenantAndVertical('tenant-1', 'hvac');

    expect(active.map((asset) => asset.id)).toEqual(['asset-1']);
  });

  it('updates lifecycle status without duplicating assets', async () => {
    const repo = new InMemoryTrainingAssetRepository();
    await repo.save(makeAsset({ id: 'asset-1', status: 'redacted' }));
    await repo.save(makeAsset({ id: 'asset-1', status: 'approved', approvedBy: 'user-2' }));

    const all = await repo.listByTenant('tenant-1');

    expect(all).toHaveLength(1);
    expect(all[0].status).toBe('approved');
    expect(all[0].approvedBy).toBe('user-2');
  });

  it('rejects duplicate in-memory asset ids from another tenant', async () => {
    const repo = new InMemoryTrainingAssetRepository();
    await repo.save(makeAsset({ id: 'asset-1', tenantId: 'tenant-1' }));

    await expect(repo.save(makeAsset({ id: 'asset-1', tenantId: 'tenant-2' }))).rejects.toThrow(
      'training asset id belongs to another tenant',
    );

    await expect(repo.findById('tenant-1', 'asset-1')).resolves.toMatchObject({
      id: 'asset-1',
      tenantId: 'tenant-1',
    });
    await expect(repo.findById('tenant-2', 'asset-1')).resolves.toBeNull();
  });

  it('uses tenant-scoped Pg upserts and lists active assets by tenant and vertical', async () => {
    const pool = new FakeTrainingAssetPool();
    const repo = new PgTrainingAssetRepository(pool as unknown as Pool);

    await repo.save(makeAsset({ id: 'asset-1', tenantId: 'tenant-1', verticalType: 'hvac' }));
    await repo.save(makeAsset({ id: 'asset-2', tenantId: 'tenant-2', verticalType: 'hvac' }));
    await repo.save(makeAsset({ id: 'asset-3', tenantId: 'tenant-1', verticalType: 'plumbing' }));
    await repo.save(makeAsset({ id: 'asset-4', tenantId: 'tenant-1', verticalType: 'hvac', status: 'draft' }));

    const active = await repo.listActiveByTenantAndVertical('tenant-1', 'hvac');

    expect(active.map((asset) => asset.id)).toEqual(['asset-1']);

    await expect(repo.findById('tenant-1', 'asset-1')).resolves.toMatchObject({ id: 'asset-1' });
    await expect(repo.findById('tenant-2', 'asset-1')).resolves.toBeNull();

    await repo.save(makeAsset({ id: 'asset-1', status: 'approved', approvedBy: 'user-2' }));

    const all = await repo.listByTenant('tenant-1');
    const assetOneRows = all.filter((asset) => asset.id === 'asset-1');

    expect(assetOneRows).toHaveLength(1);
    expect(assetOneRows[0].status).toBe('approved');
    expect(assetOneRows[0].approvedBy).toBe('user-2');
    expect(pool.client.tenantContexts).toEqual([
      'tenant-1',
      'tenant-2',
      'tenant-1',
      'tenant-1',
      'tenant-1',
      'tenant-1',
      'tenant-2',
      'tenant-1',
      'tenant-1',
    ]);
    expect(
      pool.client.queries.filter((query) => query.sql.startsWith('SELECT')).map((query) => query.values),
    ).toEqual([['tenant-1', 'hvac'], ['tenant-1', 'asset-1'], ['tenant-2', 'asset-1'], ['tenant-1']]);
    expect(pool.client.releaseCount).toBe(pool.connectCount);
  });

  it('rejects duplicate Pg asset ids from another tenant', async () => {
    const pool = new FakeTrainingAssetPool();
    const repo = new PgTrainingAssetRepository(pool as unknown as Pool);
    await repo.save(makeAsset({ id: 'asset-1', tenantId: 'tenant-1' }));

    await expect(repo.save(makeAsset({ id: 'asset-1', tenantId: 'tenant-2' }))).rejects.toThrow(
      'training asset id belongs to another tenant',
    );

    await expect(repo.findById('tenant-1', 'asset-1')).resolves.toMatchObject({
      id: 'asset-1',
      tenantId: 'tenant-1',
    });
    await expect(repo.findById('tenant-2', 'asset-1')).resolves.toBeNull();
  });
});

describe('PrivacyAuditRepository', () => {
  it('stores and returns in-memory privacy audit entries', async () => {
    const repo = new InMemoryPrivacyAuditRepository();
    const entry = makePrivacyAuditEntry();

    const created = await repo.create(entry);

    expect(created).toEqual(entry);
    expect(repo.rows).toEqual([entry]);
  });

  it('uses tenant-scoped Pg insert for privacy audit entries', async () => {
    const pool = new FakeTrainingAssetPool();
    const repo = new PgPrivacyAuditRepository(pool as unknown as Pool);
    const entry = makePrivacyAuditEntry();

    const created = await repo.create(entry);

    expect(created).toEqual(entry);
    expect(pool.client.tenantContexts).toEqual(['tenant-1']);
    expect(pool.client.privacyAuditRows).toHaveLength(1);
    expect(pool.client.queries.find((query) => query.sql.startsWith('INSERT INTO privacy_audit'))?.values).toEqual([
      entry.id,
      entry.tenantId,
      entry.actorId,
      entry.entityType,
      entry.entityId,
      entry.operation,
      JSON.stringify(entry.redactionSummary),
      JSON.stringify(entry.redactions),
      entry.createdAt,
    ]);
    expect(pool.client.releaseCount).toBe(pool.connectCount);
  });
});

describe('TrainingAssetService', () => {
  it('redacts before save and writes privacy audit without raw matched PII', async () => {
    const assetRepo = new RecordingTrainingAssetRepository();
    const privacyAuditRepo = new InMemoryPrivacyAuditRepository();
    const service = new TrainingAssetService({
      assetRepo,
      privacyAuditRepo,
      redaction: new TrainingAssetRedactionService(),
      idGenerator: () => 'asset-1',
      now: () => new Date('2026-05-15T00:00:00Z'),
    });

    const saved = await service.create({
      tenantId: 'tenant-1',
      actorId: 'user-1',
      input: {
        verticalType: 'hvac',
        assetKind: 'labeled_call_example',
        title: 'No heat emergency',
        rawText: 'Sarah Jones at 415-555-0123 has no heat.',
        labels: { intent: 'emergency_dispatch', shouldEscalate: true },
        provenance: { source: 'tenant_admin', sourceVersion: '1' },
      },
      knownEntities: { names: ['Sarah Jones'] },
    });

    expect(saved.status).toBe('redacted');
    expect(saved.scrubbedText).toContain('[CALLER_NAME]');
    expect(saved.scrubbedText).toContain('[PHONE]');
    expect(assetRepo.savedAssets).toHaveLength(1);
    expect(assetRepo.savedAssets[0].status).toBe('redacted');
    expect(assetRepo.savedAssets[0].scrubbedText).toContain('[CALLER_NAME]');
    expect(assetRepo.savedAssets[0].scrubbedText).toContain('[PHONE]');
    expect(assetRepo.savedAssets[0].redactionSummary).toBeDefined();
    expect(assetRepo.savedAssets[0].rawText).toBeUndefined();
    expect(JSON.stringify(assetRepo.savedAssets[0])).not.toContain('Sarah Jones');
    expect(JSON.stringify(assetRepo.savedAssets[0])).not.toContain('415-555-0123');
    expect(assetRepo.savedAssets.some((asset) => asset.status === 'draft')).toBe(false);
    expect(privacyAuditRepo.rows).toHaveLength(1);
    expect(JSON.stringify(privacyAuditRepo.rows[0])).not.toContain('Sarah Jones');
    expect(JSON.stringify(privacyAuditRepo.rows[0])).not.toContain('415-555-0123');
  });

  it('quarantines assets with residual PII and prevents activation', async () => {
    const service = new TrainingAssetService({
      assetRepo: new InMemoryTrainingAssetRepository(),
      privacyAuditRepo: new InMemoryPrivacyAuditRepository(),
      redaction: new TrainingAssetRedactionService(),
      idGenerator: () => 'asset-2',
      now: () => new Date('2026-05-15T00:00:00Z'),
    });

    const saved = await service.create({
      tenantId: 'tenant-1',
      actorId: 'user-1',
      input: {
        verticalType: 'plumbing',
        assetKind: 'rag_seed',
        title: 'Account leak example',
        rawText: 'Account 123456789 has a leak.',
        labels: {},
        provenance: { source: 'tenant_admin', sourceVersion: '1' },
      },
    });

    expect(saved.status).toBe('quarantined');
    expect(saved.scrubbedText).toBeUndefined();
    expect(JSON.stringify(saved)).not.toContain('123456789');
    await expect(service.approve({
      tenantId: 'tenant-1',
      actorId: 'owner-1',
      assetId: saved.id,
    })).rejects.toThrow('Cannot approve quarantined training asset');
  });

  it('approves then activates a redacted asset', async () => {
    const service = new TrainingAssetService({
      assetRepo: new InMemoryTrainingAssetRepository(),
      privacyAuditRepo: new InMemoryPrivacyAuditRepository(),
      redaction: new TrainingAssetRedactionService(),
      idGenerator: () => 'asset-3',
      now: () => new Date('2026-05-15T00:00:00Z'),
    });

    const saved = await service.create({
      tenantId: 'tenant-1',
      actorId: 'user-1',
      input: {
        verticalType: 'electrical',
        assetKind: 'intake_question',
        title: 'Breaker follow-up',
        rawText: 'Ask whether one breaker is tripping or the whole panel is out.',
        labels: { expectedNextQuestion: 'Is one breaker tripping, or is the whole panel out?' },
        provenance: { source: 'tenant_admin', sourceVersion: '1' },
      },
    });

    const approved = await service.approve({
      tenantId: 'tenant-1',
      actorId: 'owner-1',
      assetId: saved.id,
    });
    const active = await service.activate({
      tenantId: 'tenant-1',
      actorId: 'owner-1',
      assetId: approved.id,
    });

    expect(active.status).toBe('active');
    expect(active.approvedBy).toBe('owner-1');
    expect(active.activatedAt?.toISOString()).toBe('2026-05-15T00:00:00.000Z');
  });
});
