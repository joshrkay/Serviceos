import type { Pool, PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import {
  InMemoryAuditRepository,
  type AuditEvent,
  type AuditRepository,
} from '../../src/audit/audit';
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
import { tenantContextStore } from '../../src/middleware/tenant-context';
import type {
  PrivacyAuditEntry,
  PrivacyAuditRepository,
  VerticalTrainingAsset,
} from '../../src/verticals/training-assets';

vi.mock('../../src/db/schema', () => ({
  setTenantContext: (tenantId: string) => `SET app.current_tenant_id = '${tenantId}'`,
  // U2b-2: the transactional tenant path validates via isValidTenantId; these
  // tests use simple ids (not UUIDs) on purpose, so accept them.
  isValidTenantId: () => true,
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

    // U2b-2: the tenant path is now a SET LOCAL transaction. Treat the framing
    // (BEGIN/COMMIT/ROLLBACK/RESET) as no-ops and capture the tenant from the
    // set_config param (it moved out of the SQL string into $1).
    if (
      normalizedSql === 'BEGIN' ||
      normalizedSql === 'COMMIT' ||
      normalizedSql === 'ROLLBACK' ||
      normalizedSql.startsWith('RESET')
    ) {
      return { rows: [] };
    }
    if (normalizedSql.startsWith('SELECT set_config')) {
      const tenantId = values[0];
      if (typeof tenantId === 'string') this.tenantContexts.push(tenantId);
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

    if (normalizedSql.startsWith('UPDATE vertical_training_assets')) {
      const tenantId = String(values[0]);
      const id = String(values[1]);
      const existing = this.rows.get(id);
      const expectedUpdatedAt = values[11] as Date;
      if (
        !existing ||
        existing.tenant_id !== tenantId ||
        existing.updated_at.getTime() !== expectedUpdatedAt.getTime()
      ) {
        return { rows: [] };
      }
      const updated: TrainingAssetRow = {
        ...existing,
        status: String(values[2]),
        title: String(values[3]),
        scrubbed_text: values[4] === null ? null : String(values[4]),
        labels: String(values[5]),
        provenance: String(values[6]),
        redaction_summary: values[7] === null ? null : String(values[7]),
        approved_by: values[8] === null ? null : String(values[8]),
        activated_at: values[9] instanceof Date ? values[9] : null,
        updated_at: values[10] as Date,
      };
      this.rows.set(id, updated);
      return { rows: [updated] };
    }

    if (normalizedSql.startsWith('SELECT 1 FROM vertical_training_assets')) {
      const existing = this.rows.get(String(values[1]));
      return { rows: existing && existing.tenant_id === values[0] ? [existing] : [] };
    }

    if (normalizedSql.startsWith('SELECT COUNT(*)')) {
      const count = [...this.rows.values()].filter((row) => row.tenant_id === values[0]).length;
      return { rows: [{ count } as unknown as TrainingAssetRow] };
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

    if (normalizedSql.startsWith('DELETE FROM privacy_audit')) {
      const index = this.privacyAuditRows.findIndex(
        (row) => row.tenant_id === values[0] && row.id === values[1],
      );
      if (index >= 0) {
        this.privacyAuditRows.splice(index, 1);
      }
      return { rows: [] };
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
      normalizedSql.includes('AND idempotency_key = $2')
    ) {
      return { rows: [] };
    }

    if (normalizedSql.startsWith('DELETE FROM vertical_training_assets')) {
      const row = this.rows.get(String(values[1]));
      if (row && row.tenant_id === values[0]) {
        this.rows.delete(row.id);
      }
      return { rows: [] };
    }

    if (
      normalizedSql.startsWith('SELECT * FROM vertical_training_assets') &&
      normalizedSql.includes("status = 'active'")
    ) {
      const rows = this.sortedRows().filter(
        (row) =>
          row.tenant_id === values[0] &&
          row.vertical_type === values[1] &&
          row.status === 'active',
      );
      const limitedRows = normalizedSql.includes('LIMIT $3')
        ? rows.slice(0, Number(values[2]))
        : rows;
      return {
        rows: limitedRows,
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
      (left, right) => {
        const updatedDiff = right.updated_at.getTime() - left.updated_at.getTime();
        return updatedDiff !== 0 ? updatedDiff : left.id.localeCompare(right.id);
      },
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

  async tryUpdate(
    asset: VerticalTrainingAsset,
    expectedUpdatedAt: Date,
  ): Promise<ReturnType<InMemoryTrainingAssetRepository['tryUpdate']> extends Promise<infer T> ? T : never> {
    const result = await super.tryUpdate(asset, expectedUpdatedAt);
    if (result.kind === 'updated') {
      this.savedAssets.push({ ...result.asset });
    }
    return result;
  }
}

class FailingPrivacyAuditRepository implements PrivacyAuditRepository {
  async create(_entry: PrivacyAuditEntry): Promise<PrivacyAuditEntry> {
    throw new Error('privacy audit unavailable');
  }

  async delete(_tenantId: string, _id: string): Promise<void> {}
}

class FailingAuditRepository implements AuditRepository {
  async create(_event: AuditEvent): Promise<AuditEvent> {
    throw new Error('audit unavailable');
  }

  async findByEntity(): Promise<AuditEvent[]> {
    return [];
  }

  async findByCorrelation(): Promise<AuditEvent[]> {
    return [];
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

  it('lists active in-memory assets by updatedAt descending with an optional limit', async () => {
    const repo = new InMemoryTrainingAssetRepository();
    await repo.save(makeAsset({
      id: 'asset-oldest',
      updatedAt: new Date('2026-05-15T00:00:00Z'),
    }));
    await repo.save(makeAsset({
      id: 'asset-z',
      updatedAt: new Date('2026-05-15T03:00:00Z'),
    }));
    await repo.save(makeAsset({
      id: 'asset-a',
      updatedAt: new Date('2026-05-15T03:00:00Z'),
    }));
    await repo.save(makeAsset({
      id: 'asset-middle',
      updatedAt: new Date('2026-05-15T02:00:00Z'),
    }));
    await repo.save(makeAsset({
      id: 'asset-draft-newer',
      status: 'draft',
      updatedAt: new Date('2026-05-15T04:00:00Z'),
    }));

    const active = await repo.listActiveByTenantAndVertical('tenant-1', 'hvac', 2);

    expect(active.map((asset) => asset.id)).toEqual(['asset-a', 'asset-z']);
  });

  it('updates lifecycle status without duplicating assets', async () => {
    const repo = new InMemoryTrainingAssetRepository();
    await repo.save(makeAsset({ id: 'asset-1', status: 'redacted' }));
    await repo.save(makeAsset({ id: 'asset-1', status: 'approved', approvedBy: 'user-2' }));

    const page = await repo.listByTenant('tenant-1');

    expect(page.data).toHaveLength(1);
    expect(page.total).toBe(1);
    expect(page.data[0].status).toBe('approved');
    expect(page.data[0].approvedBy).toBe('user-2');
  });

  it('deletes in-memory assets with tenant guard', async () => {
    const repo = new InMemoryTrainingAssetRepository();
    await repo.save(makeAsset({ id: 'asset-1', tenantId: 'tenant-1' }));

    await repo.delete('tenant-2', 'asset-1');
    await expect(repo.findById('tenant-1', 'asset-1')).resolves.toMatchObject({ id: 'asset-1' });

    await repo.delete('tenant-1', 'asset-1');
    await expect(repo.findById('tenant-1', 'asset-1')).resolves.toBeNull();
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

    const page = await repo.listByTenant('tenant-1');
    const assetOneRows = page.data.filter((asset) => asset.id === 'asset-1');

    expect(assetOneRows).toHaveLength(1);
    expect(assetOneRows[0].status).toBe('approved');
    expect(assetOneRows[0].approvedBy).toBe('user-2');
    expect(page.total).toBe(3);
    expect(page.limit).toBe(50);
    expect(page.offset).toBe(0);
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
    const selectValues = pool.client.queries
      .filter((query) => query.sql.startsWith('SELECT') && !query.sql.startsWith('SELECT 1') && !query.sql.startsWith('SELECT set_config'))
      .map((query) => query.values);
    expect(selectValues).toEqual([
      ['tenant-1', 'hvac'],
      ['tenant-1', 'asset-1'],
      ['tenant-2', 'asset-1'],
      ['tenant-1', 50, 0],
      ['tenant-1'],
    ]);
    expect(pool.client.releaseCount).toBe(pool.connectCount);
  });

  it('lists active Pg assets by updated_at descending with a parameterized limit', async () => {
    const pool = new FakeTrainingAssetPool();
    const repo = new PgTrainingAssetRepository(pool as unknown as Pool);

    await repo.save(makeAsset({
      id: 'asset-oldest',
      updatedAt: new Date('2026-05-15T00:00:00Z'),
    }));
    await repo.save(makeAsset({
      id: 'asset-z',
      updatedAt: new Date('2026-05-15T03:00:00Z'),
    }));
    await repo.save(makeAsset({
      id: 'asset-a',
      updatedAt: new Date('2026-05-15T03:00:00Z'),
    }));
    await repo.save(makeAsset({
      id: 'asset-middle',
      updatedAt: new Date('2026-05-15T02:00:00Z'),
    }));

    const active = await repo.listActiveByTenantAndVertical('tenant-1', 'hvac', 2);

    expect(active.map((asset) => asset.id)).toEqual(['asset-a', 'asset-z']);
    const select = pool.client.queries.find((query) =>
      query.sql.includes("status = 'active'"),
    );
    expect(select?.sql).toContain('ORDER BY updated_at DESC, id ASC');
    expect(select?.sql).toContain('LIMIT $3');
    expect(select?.values).toEqual(['tenant-1', 'hvac', 2]);
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

  it('deletes Pg assets with tenant guard', async () => {
    const pool = new FakeTrainingAssetPool();
    const repo = new PgTrainingAssetRepository(pool as unknown as Pool);
    await repo.save(makeAsset({ id: 'asset-1', tenantId: 'tenant-1' }));

    await repo.delete('tenant-2', 'asset-1');
    await expect(repo.findById('tenant-1', 'asset-1')).resolves.toMatchObject({ id: 'asset-1' });

    await repo.delete('tenant-1', 'asset-1');
    await expect(repo.findById('tenant-1', 'asset-1')).resolves.toBeNull();
    expect(pool.client.queries.some((query) =>
      query.sql === 'DELETE FROM vertical_training_assets WHERE tenant_id = $1 AND id = $2',
    )).toBe(true);
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

  it('deletes Pg privacy audit entries with tenant guard', async () => {
    const pool = new FakeTrainingAssetPool();
    const repo = new PgPrivacyAuditRepository(pool as unknown as Pool);
    const entry = makePrivacyAuditEntry({ id: 'audit-delete-1', tenantId: 'tenant-1' });
    await repo.create(entry);

    await repo.delete('tenant-2', entry.id);
    expect(pool.client.privacyAuditRows).toHaveLength(1);

    await repo.delete('tenant-1', entry.id);
    expect(pool.client.privacyAuditRows).toEqual([]);
    expect(pool.client.queries.some((query) =>
      query.sql === 'DELETE FROM privacy_audit WHERE tenant_id = $1 AND id = $2',
    )).toBe(true);
  });
});

describe('TrainingAssetService', () => {
  it('redacts before save and writes privacy audit without raw matched PII', async () => {
    const assetRepo = new RecordingTrainingAssetRepository();
    const privacyAuditRepo = new InMemoryPrivacyAuditRepository();
    const service = new TrainingAssetService({
      assetRepo,
      privacyAuditRepo,
      auditRepo: new InMemoryAuditRepository(),
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

  it('rolls back created assets when privacy audit creation fails', async () => {
    const assetRepo = new RecordingTrainingAssetRepository();
    const service = new TrainingAssetService({
      assetRepo,
      privacyAuditRepo: new FailingPrivacyAuditRepository(),
      auditRepo: new InMemoryAuditRepository(),
      redaction: new TrainingAssetRedactionService(),
      idGenerator: () => 'asset-audit-fail-1',
      now: () => new Date('2026-05-15T00:00:00Z'),
    });

    await expect(service.create({
      tenantId: 'tenant-1',
      actorId: 'user-1',
      input: {
        verticalType: 'hvac',
        assetKind: 'prompt_context',
        title: 'Audit failure case',
        rawText: 'Caller has no heat.',
        labels: {},
        provenance: { source: 'tenant_admin', sourceVersion: '1' },
      },
    })).rejects.toThrow('privacy audit unavailable');

    expect(assetRepo.savedAssets).toHaveLength(1);
    await expect(assetRepo.listByTenant('tenant-1')).resolves.toMatchObject({ data: [], total: 0 });
  });

  it('rolls back created assets when standard audit creation fails', async () => {
    const assetRepo = new RecordingTrainingAssetRepository();
    const privacyAuditRepo = new InMemoryPrivacyAuditRepository();
    const service = new TrainingAssetService({
      assetRepo,
      privacyAuditRepo,
      auditRepo: new FailingAuditRepository(),
      redaction: new TrainingAssetRedactionService(),
      idGenerator: () => 'asset-audit-fail-2',
      now: () => new Date('2026-05-15T00:00:00Z'),
    });

    await expect(service.create({
      tenantId: 'tenant-1',
      actorId: 'user-1',
      input: {
        verticalType: 'hvac',
        assetKind: 'prompt_context',
        title: 'Audit failure case',
        rawText: 'Caller has no heat.',
        labels: {},
        provenance: { source: 'tenant_admin', sourceVersion: '1' },
      },
    })).rejects.toThrow('audit unavailable');

    expect(assetRepo.savedAssets).toHaveLength(1);
    await expect(assetRepo.listByTenant('tenant-1')).resolves.toMatchObject({ data: [], total: 0 });
    expect(privacyAuditRepo.rows).toEqual([]);
  });

  it('quarantines assets with residual PII and prevents activation', async () => {
    const service = new TrainingAssetService({
      assetRepo: new InMemoryTrainingAssetRepository(),
      privacyAuditRepo: new InMemoryPrivacyAuditRepository(),
      auditRepo: new InMemoryAuditRepository(),
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

  it('redacts metadata before save and records safe audit redactions', async () => {
    const assetRepo = new RecordingTrainingAssetRepository();
    const privacyAuditRepo = new InMemoryPrivacyAuditRepository();
    const service = new TrainingAssetService({
      assetRepo,
      privacyAuditRepo,
      auditRepo: new InMemoryAuditRepository(),
      redaction: new TrainingAssetRedactionService(),
      idGenerator: () => 'asset-4',
      now: () => new Date('2026-05-15T00:00:00Z'),
    });

    const saved = await service.create({
      tenantId: 'tenant-1',
      actorId: 'user-1',
      input: {
        verticalType: 'hvac',
        assetKind: 'labeled_call_example',
        title: 'Sarah Jones no heat call',
        rawText: 'Caller has no heat.',
        labels: {
          intent: 'emergency_dispatch',
          shouldEscalate: true,
          entities: {
            serviceAddress: '123 Main St',
            callerPhone: '415-555-0123',
          },
        },
        provenance: {
          source: 'tenant_admin',
          sourceVersion: '1',
          notes: 'Admin note from 415-555-0123',
        },
      },
      knownEntities: { names: ['Sarah Jones'] },
    });

    expect(saved.status).toBe('redacted');
    expect(saved.title).toBe('[CALLER_NAME] no heat call');
    expect(saved.provenance.notes).toBe('Admin note from [PHONE]');
    expect(saved.labels.entities).toEqual({
      serviceAddress: '[ADDRESS]',
      callerPhone: '[PHONE]',
    });
    expect(assetRepo.savedAssets).toHaveLength(1);
    const persistedJson = JSON.stringify(assetRepo.savedAssets[0]);
    expect(persistedJson).not.toContain('Sarah Jones');
    expect(persistedJson).not.toContain('123 Main St');
    expect(persistedJson).not.toContain('415-555-0123');
    expect(privacyAuditRepo.rows).toHaveLength(1);
    expect(privacyAuditRepo.rows[0].redactions.length).toBeGreaterThan(1);
    expect(JSON.stringify(privacyAuditRepo.rows[0])).not.toContain('Sarah Jones');
    expect(JSON.stringify(privacyAuditRepo.rows[0])).not.toContain('123 Main St');
    expect(JSON.stringify(privacyAuditRepo.rows[0])).not.toContain('415-555-0123');
    const sourceFields = new Set(
      privacyAuditRepo.rows[0].redactions.map((redaction) => redaction.sourceField),
    );
    expect(sourceFields.has('title')).toBe(true);
    expect(sourceFields.has('provenance.notes')).toBe(true);
    // Entity redactions identify the nested entity field so two
    // different PII-bearing entries don't collapse into one ambiguous
    // audit row.
    expect(sourceFields.has('labels.entities.serviceAddress')).toBe(true);
    expect(sourceFields.has('labels.entities.callerPhone')).toBe(true);
    for (const redaction of privacyAuditRepo.rows[0].redactions) {
      expect(typeof redaction.sourceField).toBe('string');
      expect(redaction.sourceField.length).toBeGreaterThan(0);
    }
  });

  it('returns the original asset when create is retried with the same idempotency key', async () => {
    const assetRepo = new RecordingTrainingAssetRepository();
    const privacyAuditRepo = new InMemoryPrivacyAuditRepository();
    const auditRepo = new InMemoryAuditRepository();
    let counter = 0;
    const service = new TrainingAssetService({
      assetRepo,
      privacyAuditRepo,
      auditRepo,
      redaction: new TrainingAssetRedactionService(),
      idGenerator: () => `asset-idem-${++counter}`,
      now: () => new Date('2026-05-15T00:00:00Z'),
    });

    const baseRequest = {
      tenantId: 'tenant-1',
      actorId: 'user-1',
      idempotencyKey: 'create-key-1',
      input: {
        verticalType: 'hvac' as const,
        assetKind: 'prompt_context' as const,
        title: 'Idempotent create',
        rawText: 'Caller has no heat.',
        labels: {},
        provenance: { source: 'tenant_admin' as const, sourceVersion: '1' },
      },
    };

    const first = await service.create(baseRequest);
    const replay = await service.create(baseRequest);

    expect(replay.id).toBe(first.id);
    expect(assetRepo.savedAssets).toHaveLength(1);
    expect(privacyAuditRepo.rows).toHaveLength(1);
    expect(auditRepo.getAll().filter((event) => event.eventType === 'vertical_training_asset.created')).toHaveLength(1);
  });

  it('rejects approve when the asset was updated after the read (optimistic concurrency)', async () => {
    const assetRepo = new InMemoryTrainingAssetRepository();
    const originalAsset = makeAsset({
      id: 'asset-concurrent',
      status: 'redacted',
      rawText: undefined,
      scrubbedText: 'Safe redacted text.',
      updatedAt: new Date('2026-05-15T00:00:00Z'),
    });
    await assetRepo.save(originalAsset);

    const service = new TrainingAssetService({
      assetRepo,
      privacyAuditRepo: new InMemoryPrivacyAuditRepository(),
      auditRepo: new InMemoryAuditRepository(),
      redaction: new TrainingAssetRedactionService(),
      now: () => new Date('2026-05-15T01:00:00Z'),
    });

    // Simulate a concurrent writer bumping updatedAt between findById and tryUpdate.
    const findById = assetRepo.findById.bind(assetRepo);
    assetRepo.findById = async (tenantId, id) => {
      const result = await findById(tenantId, id);
      if (result) {
        // Concurrent writer comes in *after* the read returned.
        await assetRepo.save({
          ...result,
          updatedAt: new Date('2026-05-15T00:30:00Z'),
        });
      }
      return result;
    };

    await expect(service.approve({
      tenantId: 'tenant-1',
      actorId: 'owner-1',
      assetId: 'asset-concurrent',
    })).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('invalidates the prompt cache after a successful activation', async () => {
    const assetRepo = new InMemoryTrainingAssetRepository();
    await assetRepo.save(makeAsset({
      id: 'asset-activate-invalidate',
      status: 'approved',
      rawText: undefined,
      scrubbedText: 'Safe approved text.',
      approvedBy: 'owner-1',
    }));
    const invalidations: string[] = [];
    const service = new TrainingAssetService({
      assetRepo,
      privacyAuditRepo: new InMemoryPrivacyAuditRepository(),
      auditRepo: new InMemoryAuditRepository(),
      redaction: new TrainingAssetRedactionService(),
      now: () => new Date('2026-05-15T01:00:00Z'),
      invalidatePromptCache: (tenantId) => invalidations.push(tenantId),
    });

    await service.activate({
      tenantId: 'tenant-1',
      actorId: 'owner-1',
      assetId: 'asset-activate-invalidate',
    });

    expect(invalidations).toEqual(['tenant-1']);
  });

  it('does not leave a success audit row when the privacy audit write fails', async () => {
    const assetRepo = new InMemoryTrainingAssetRepository();
    const auditRepo = new InMemoryAuditRepository();
    await assetRepo.save(makeAsset({
      id: 'asset-orphan-audit',
      status: 'redacted',
      rawText: undefined,
      scrubbedText: 'Safe redacted text.',
    }));
    const service = new TrainingAssetService({
      assetRepo,
      privacyAuditRepo: new FailingPrivacyAuditRepository(),
      auditRepo,
      redaction: new TrainingAssetRedactionService(),
      now: () => new Date('2026-05-15T01:00:00Z'),
    });

    await expect(service.approve({
      tenantId: 'tenant-1',
      actorId: 'owner-1',
      assetId: 'asset-orphan-audit',
    })).rejects.toThrow('privacy audit unavailable');

    expect(auditRepo.getAll()).toEqual([]);
    await expect(assetRepo.findById('tenant-1', 'asset-orphan-audit')).resolves.toMatchObject({
      status: 'redacted',
    });
  });

  it('deletes the privacy_audit row when the standard audit write fails after it succeeds', async () => {
    const assetRepo = new InMemoryTrainingAssetRepository();
    const privacyAuditRepo = new InMemoryPrivacyAuditRepository();
    await assetRepo.save(makeAsset({
      id: 'asset-rollback-cleanup',
      status: 'redacted',
      rawText: undefined,
      scrubbedText: 'Safe redacted text.',
    }));
    const service = new TrainingAssetService({
      assetRepo,
      privacyAuditRepo,
      auditRepo: new FailingAuditRepository(),
      redaction: new TrainingAssetRedactionService(),
      now: () => new Date('2026-05-15T01:00:00Z'),
    });

    await expect(service.approve({
      tenantId: 'tenant-1',
      actorId: 'owner-1',
      assetId: 'asset-rollback-cleanup',
    })).rejects.toThrow('audit unavailable');

    expect(privacyAuditRepo.rows).toEqual([]);
    await expect(assetRepo.findById('tenant-1', 'asset-rollback-cleanup')).resolves.toMatchObject({
      status: 'redacted',
    });
  });

  it('does not redact domain vocabulary like "Water Heater" or "Circuit Breaker"', async () => {
    const assetRepo = new RecordingTrainingAssetRepository();
    const service = new TrainingAssetService({
      assetRepo,
      privacyAuditRepo: new InMemoryPrivacyAuditRepository(),
      auditRepo: new InMemoryAuditRepository(),
      redaction: new TrainingAssetRedactionService(),
      idGenerator: () => 'asset-vocab',
      now: () => new Date('2026-05-15T00:00:00Z'),
    });

    const saved = await service.create({
      tenantId: 'tenant-1',
      actorId: 'user-1',
      input: {
        verticalType: 'hvac',
        assetKind: 'prompt_context',
        title: 'Water Heater installation',
        rawText:
          'Ask whether the Water Heater is gas or electric. ' +
          'Verify the Circuit Breaker has not tripped on the Heat Pump.',
        labels: { intent: 'Service Call routing' },
        provenance: { source: 'tenant_admin', sourceVersion: '1' },
      },
    });

    expect(saved.status).toBe('redacted');
    expect(saved.title).toBe('Water Heater installation');
    expect(saved.labels.intent).toBe('Service Call routing');
    expect(saved.scrubbedText).toContain('Water Heater');
    expect(saved.scrubbedText).toContain('Circuit Breaker');
    expect(saved.scrubbedText).toContain('Heat Pump');
    expect(saved.scrubbedText).not.toContain('[NAME]');
  });

  it('redacts individual entity values without round-tripping through JSON', async () => {
    const assetRepo = new RecordingTrainingAssetRepository();
    const service = new TrainingAssetService({
      assetRepo,
      privacyAuditRepo: new InMemoryPrivacyAuditRepository(),
      auditRepo: new InMemoryAuditRepository(),
      redaction: new TrainingAssetRedactionService(),
      idGenerator: () => 'asset-entities',
      now: () => new Date('2026-05-15T00:00:00Z'),
    });

    const saved = await service.create({
      tenantId: 'tenant-1',
      actorId: 'user-1',
      input: {
        verticalType: 'hvac',
        assetKind: 'labeled_call_example',
        title: 'Entities iteration case',
        rawText: 'Caller has no heat.',
        labels: {
          entities: {
            primaryPhone: '415-555-0123',
            equipmentTags: ['Heat Pump', 'serial 415-555-9999'],
            address: { street: '123 Main St', unit: 'Apt 4' },
            // A key that looks like JSON would have broken the old stringify path.
            'note"key': 'follow up with the customer',
          },
        },
        provenance: { source: 'tenant_admin', sourceVersion: '1' },
      },
    });

    expect(saved.labels.entities).toEqual({
      primaryPhone: '[PHONE]',
      equipmentTags: ['Heat Pump', 'serial [PHONE]'],
      address: { street: '[ADDRESS]', unit: 'Apt 4' },
      'note"key': 'follow up with the customer',
    });
  });

  it('tags privacy audit redactions with offsetBasis = original vs scrubbed', async () => {
    const assetRepo = new RecordingTrainingAssetRepository();
    const privacyAuditRepo = new InMemoryPrivacyAuditRepository();
    const service = new TrainingAssetService({
      assetRepo,
      privacyAuditRepo,
      auditRepo: new InMemoryAuditRepository(),
      redaction: new TrainingAssetRedactionService(),
      idGenerator: () => 'asset-offset',
      now: () => new Date('2026-05-15T00:00:00Z'),
    });

    await service.create({
      tenantId: 'tenant-1',
      actorId: 'user-1',
      input: {
        verticalType: 'hvac',
        assetKind: 'labeled_call_example',
        title: 'Caller Margaret Thatcher example',
        rawText: 'Margaret Thatcher at 415-555-0123 needs service.',
        labels: {},
        provenance: { source: 'tenant_admin', sourceVersion: '1' },
      },
      knownEntities: { phones: ['415-555-0123'] },
    });

    const redactions = privacyAuditRepo.rows[0].redactions;
    expect(redactions.length).toBeGreaterThan(0);
    for (const redaction of redactions) {
      expect(['original', 'scrubbed']).toContain(redaction.offsetBasis);
    }
    // Phone-number redactions are emitted by the primary scrubber against
    // the original text (tagged `phone` for regex matches or `known_phone`
    // when knownEntities supplied it).
    expect(redactions.some(
      (r) => (r.kind === 'phone' || r.kind === 'known_phone') && r.offsetBasis === 'original',
    )).toBe(true);
    // The "Margaret Thatcher" -> [NAME] redaction comes from the
    // metadata-name fallback which scans the post-scrub text.
    expect(redactions.some((r) => r.kind === 'metadata_name' && r.offsetBasis === 'scrubbed')).toBe(true);
  });

  it('archives an approved asset and emits an archive audit event', async () => {
    const assetRepo = new InMemoryTrainingAssetRepository();
    const auditRepo = new InMemoryAuditRepository();
    await assetRepo.save(makeAsset({
      id: 'asset-archive-1',
      status: 'active',
      rawText: undefined,
      scrubbedText: 'Safe active text.',
      approvedBy: 'owner-1',
      activatedAt: new Date('2026-05-15T00:00:00Z'),
    }));
    const service = new TrainingAssetService({
      assetRepo,
      privacyAuditRepo: new InMemoryPrivacyAuditRepository(),
      auditRepo,
      redaction: new TrainingAssetRedactionService(),
      now: () => new Date('2026-05-15T02:00:00Z'),
    });

    const archived = await service.archive({
      tenantId: 'tenant-1',
      actorId: 'owner-1',
      assetId: 'asset-archive-1',
    });

    expect(archived.status).toBe('archived');
    expect(auditRepo.getAll().map((event) => event.eventType)).toEqual([
      'vertical_training_asset.archived',
    ]);
  });

  it('sanitizes provenance identifiers before save and audit', async () => {
    const assetRepo = new RecordingTrainingAssetRepository();
    const privacyAuditRepo = new InMemoryPrivacyAuditRepository();
    const service = new TrainingAssetService({
      assetRepo,
      privacyAuditRepo,
      auditRepo: new InMemoryAuditRepository(),
      redaction: new TrainingAssetRedactionService(),
      idGenerator: () => 'asset-provenance-1',
      now: () => new Date('2026-05-15T00:00:00Z'),
    });

    const saved = await service.create({
      tenantId: 'tenant-1',
      actorId: 'user-1',
      input: {
        verticalType: 'hvac',
        assetKind: 'prompt_context',
        title: 'Provenance privacy case',
        rawText: 'Caller has no heat.',
        labels: {},
        provenance: {
          source: 'tenant_admin',
          sourceId: 'Sarah Jones 415-555-0123 at 123 Main St',
          sourceVersion: 'account 123456789',
        },
      },
      knownEntities: { names: ['Sarah Jones'] },
    });

    expect(saved.status).toBe('quarantined');
    expect(saved.provenance.sourceId).toBeUndefined();
    expect(saved.provenance.sourceVersion).toBe('redacted');
    expect(assetRepo.savedAssets).toHaveLength(1);
    expect(assetRepo.savedAssets[0].provenance.sourceId).toBeUndefined();
    expect(assetRepo.savedAssets[0].provenance.sourceVersion).toBe('redacted');
    expect(JSON.stringify(saved)).not.toContain('Sarah Jones');
    expect(JSON.stringify(saved)).not.toContain('415-555-0123');
    expect(JSON.stringify(saved)).not.toContain('123 Main St');
    expect(JSON.stringify(saved)).not.toContain('123456789');
    expect(JSON.stringify(assetRepo.savedAssets[0])).not.toContain('Sarah Jones');
    expect(JSON.stringify(assetRepo.savedAssets[0])).not.toContain('415-555-0123');
    expect(JSON.stringify(assetRepo.savedAssets[0])).not.toContain('123 Main St');
    expect(JSON.stringify(assetRepo.savedAssets[0])).not.toContain('123456789');
    expect(privacyAuditRepo.rows[0].redactions.length).toBeGreaterThan(0);
    expect(JSON.stringify(privacyAuditRepo.rows[0])).not.toContain('Sarah Jones');
    expect(JSON.stringify(privacyAuditRepo.rows[0])).not.toContain('415-555-0123');
    expect(JSON.stringify(privacyAuditRepo.rows[0])).not.toContain('123 Main St');
    expect(JSON.stringify(privacyAuditRepo.rows[0])).not.toContain('123456789');
  });

  it('redacts likely title-case names from metadata without known entities', async () => {
    const assetRepo = new RecordingTrainingAssetRepository();
    const privacyAuditRepo = new InMemoryPrivacyAuditRepository();
    const service = new TrainingAssetService({
      assetRepo,
      privacyAuditRepo,
      auditRepo: new InMemoryAuditRepository(),
      redaction: new TrainingAssetRedactionService(),
      idGenerator: () => 'asset-name-fallback-1',
      now: () => new Date('2026-05-15T00:00:00Z'),
    });

    const saved = await service.create({
      tenantId: 'tenant-1',
      actorId: 'user-1',
      input: {
        verticalType: 'hvac',
        assetKind: 'eval_scenario',
        title: 'Sarah Jones no heat call',
        rawText: 'Caller has no heat.',
        labels: {
          expectedNextQuestion: 'Ask Sarah Jones whether heat is out.',
          expectedNextAction: 'Schedule Sarah Jones for diagnostic.',
          expectedRetrievalTerms: ['Sarah Jones furnace history'],
          entities: { callerName: 'Sarah Jones' },
        },
        provenance: {
          source: 'tenant_admin',
          sourceId: 'Sarah Jones upload',
          sourceVersion: 'Sarah Jones v1',
          notes: 'Sarah Jones provided this example',
        },
      },
    });

    expect(saved.title).toBe('[NAME] no heat call');
    expect(saved.provenance.sourceId).toBe('[NAME] upload');
    expect(saved.provenance.sourceVersion).toBe('[NAME] v1');
    expect(saved.provenance.notes).toBe('[NAME] provided this example');
    expect(saved.labels.expectedNextQuestion).toBe('Ask [NAME] whether heat is out.');
    expect(saved.labels.expectedNextAction).toBe('Schedule [NAME] for diagnostic.');
    expect(saved.labels.expectedRetrievalTerms).toEqual(['[NAME] furnace history']);
    expect(saved.labels.entities).toEqual({ callerName: '[NAME]' });
    expect(JSON.stringify(saved)).not.toContain('Sarah Jones');
    expect(JSON.stringify(assetRepo.savedAssets[0])).not.toContain('Sarah Jones');
    expect(privacyAuditRepo.rows).toHaveLength(1);
    expect(privacyAuditRepo.rows[0].redactionSummary.redactionCount).toBeGreaterThan(0);
    expect(privacyAuditRepo.rows[0].redactionSummary.redactionKinds).toContain('metadata_name');
    expect(privacyAuditRepo.rows[0].redactionSummary.placeholders).toContain('[NAME]');
    expect(privacyAuditRepo.rows[0].redactions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'metadata_name',
          placeholder: '[NAME]',
          start: expect.any(Number),
          end: expect.any(Number),
        }),
      ]),
    );
    expect(JSON.stringify(privacyAuditRepo.rows[0])).not.toContain('Sarah Jones');
  });

  it('redacts likely title-case names from raw text without known entities', async () => {
    const assetRepo = new RecordingTrainingAssetRepository();
    const service = new TrainingAssetService({
      assetRepo,
      privacyAuditRepo: new InMemoryPrivacyAuditRepository(),
      auditRepo: new InMemoryAuditRepository(),
      redaction: new TrainingAssetRedactionService(),
      idGenerator: () => 'asset-raw-name-fallback-1',
      now: () => new Date('2026-05-15T00:00:00Z'),
    });

    const saved = await service.create({
      tenantId: 'tenant-1',
      actorId: 'user-1',
      input: {
        verticalType: 'hvac',
        assetKind: 'prompt_context',
        title: 'Raw text privacy case',
        rawText: 'Sarah Jones has no heat',
        labels: {},
        provenance: { source: 'tenant_admin', sourceVersion: '1' },
      },
    });

    expect(saved.status).toBe('redacted');
    expect(saved.scrubbedText).toBe('[NAME] has no heat');
    expect(JSON.stringify(saved)).not.toContain('Sarah Jones');
    expect(JSON.stringify(assetRepo.savedAssets[0])).not.toContain('Sarah Jones');
  });

  it('quarantines residual metadata and falls back to safe metadata fields', async () => {
    const service = new TrainingAssetService({
      assetRepo: new InMemoryTrainingAssetRepository(),
      privacyAuditRepo: new InMemoryPrivacyAuditRepository(),
      auditRepo: new InMemoryAuditRepository(),
      redaction: new TrainingAssetRedactionService(),
      idGenerator: () => 'asset-5',
      now: () => new Date('2026-05-15T00:00:00Z'),
    });

    const saved = await service.create({
      tenantId: 'tenant-1',
      actorId: 'user-1',
      input: {
        verticalType: 'plumbing',
        assetKind: 'rag_seed',
        title: 'Account 123456789 leak',
        rawText: 'Ask whether the water is shut off.',
        labels: {
          intent: 'emergency_dispatch',
          entities: { accountNumber: '123456789' },
        },
        provenance: {
          source: 'tenant_admin',
          sourceVersion: '1',
          notes: 'Follow up on account 123456789',
        },
      },
    });

    expect(saved.status).toBe('quarantined');
    expect(saved.title).toBe('Quarantined training asset');
    expect(saved.scrubbedText).toBeUndefined();
    expect(saved.provenance.notes).toBeUndefined();
    expect(saved.labels.intent).toBe('emergency_dispatch');
    expect(saved.labels.entities).toBeUndefined();
    expect(JSON.stringify(saved)).not.toContain('123456789');
  });

  it('sanitizes free-form label text before save and audit', async () => {
    const assetRepo = new RecordingTrainingAssetRepository();
    const privacyAuditRepo = new InMemoryPrivacyAuditRepository();
    const service = new TrainingAssetService({
      assetRepo,
      privacyAuditRepo,
      auditRepo: new InMemoryAuditRepository(),
      redaction: new TrainingAssetRedactionService(),
      idGenerator: () => 'asset-6',
      now: () => new Date('2026-05-15T00:00:00Z'),
    });

    const saved = await service.create({
      tenantId: 'tenant-1',
      actorId: 'user-1',
      input: {
        verticalType: 'hvac',
        assetKind: 'eval_scenario',
        title: 'Label privacy case',
        rawText: 'Caller has no heat.',
        labels: {
          intent: 'Call Sarah Jones at 415-555-0123',
          expectedNextQuestion: 'Ask Sarah Jones whether 123 Main St has heat.',
          expectedNextAction: 'Dispatch to 123 Main St',
          expectedRetrievalTerms: [
            'Sarah Jones furnace history',
            'account 123456789',
            'call 415-555-0123',
          ],
          shouldEscalate: true,
          urgencyTier: 'emergency',
        },
        provenance: { source: 'tenant_admin', sourceVersion: '1' },
      },
      knownEntities: { names: ['Sarah Jones'] },
    });

    expect(saved.status).toBe('quarantined');
    expect(saved.labels.intent).toBe('Call [CALLER_NAME] at [PHONE]');
    expect(saved.labels.expectedNextQuestion).toBe(
      'Ask [CALLER_NAME] whether [ADDRESS] has heat.',
    );
    expect(saved.labels.expectedNextAction).toBe('Dispatch to [ADDRESS]');
    expect(saved.labels.expectedRetrievalTerms).toEqual([
      '[CALLER_NAME] furnace history',
      'call [PHONE]',
    ]);
    expect(saved.labels.shouldEscalate).toBe(true);
    expect(saved.labels.urgencyTier).toBe('emergency');
    expect(assetRepo.savedAssets).toHaveLength(1);
    const persistedJson = JSON.stringify(assetRepo.savedAssets[0]);
    expect(persistedJson).not.toContain('Sarah Jones');
    expect(persistedJson).not.toContain('415-555-0123');
    expect(persistedJson).not.toContain('123 Main St');
    expect(persistedJson).not.toContain('123456789');
    expect(privacyAuditRepo.rows).toHaveLength(1);
    expect(privacyAuditRepo.rows[0].redactions.length).toBeGreaterThan(1);
    expect(JSON.stringify(privacyAuditRepo.rows[0])).not.toContain('Sarah Jones');
    expect(JSON.stringify(privacyAuditRepo.rows[0])).not.toContain('415-555-0123');
    expect(JSON.stringify(privacyAuditRepo.rows[0])).not.toContain('123 Main St');
    expect(JSON.stringify(privacyAuditRepo.rows[0])).not.toContain('123456789');
  });

  it('approves then activates a redacted asset', async () => {
    const auditRepo = new InMemoryAuditRepository();
    const service = new TrainingAssetService({
      assetRepo: new InMemoryTrainingAssetRepository(),
      privacyAuditRepo: new InMemoryPrivacyAuditRepository(),
      auditRepo,
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
    expect(auditRepo.getAll().map((event) => ({
      eventType: event.eventType,
      entityType: event.entityType,
      entityId: event.entityId,
      actorId: event.actorId,
      actorRole: event.actorRole,
      metadata: event.metadata,
    }))).toEqual([
      {
        eventType: 'vertical_training_asset.created',
        entityType: 'vertical_training_asset',
        entityId: saved.id,
        actorId: 'user-1',
        actorRole: 'user',
        metadata: {
          status: 'redacted',
          verticalType: 'electrical',
          assetKind: 'intake_question',
        },
      },
      {
        eventType: 'vertical_training_asset.approved',
        entityType: 'vertical_training_asset',
        entityId: saved.id,
        actorId: 'owner-1',
        actorRole: 'user',
        metadata: {
          previousStatus: 'redacted',
          status: 'approved',
        },
      },
      {
        eventType: 'vertical_training_asset.activated',
        entityType: 'vertical_training_asset',
        entityId: saved.id,
        actorId: 'owner-1',
        actorRole: 'user',
        metadata: {
          previousStatus: 'approved',
          status: 'active',
        },
      },
    ]);
    expect(JSON.stringify(auditRepo.getAll())).not.toContain('Breaker follow-up');
    expect(JSON.stringify(auditRepo.getAll())).not.toContain('Ask whether one breaker');
  });

  it('returns an already approved asset without duplicate saves or audit events', async () => {
    const assetRepo = new RecordingTrainingAssetRepository();
    const auditRepo = new InMemoryAuditRepository();
    const approvedAsset = makeAsset({
      id: 'asset-approved-retry',
      status: 'approved',
      rawText: undefined,
      scrubbedText: 'Safe approved training text.',
      approvedBy: 'owner-1',
      updatedAt: new Date('2026-05-15T01:00:00Z'),
    });
    await assetRepo.save(approvedAsset);
    assetRepo.savedAssets.length = 0;
    const service = new TrainingAssetService({
      assetRepo,
      privacyAuditRepo: new InMemoryPrivacyAuditRepository(),
      auditRepo,
      redaction: new TrainingAssetRedactionService(),
      now: () => new Date('2026-05-15T02:00:00Z'),
    });

    const retried = await service.approve({
      tenantId: 'tenant-1',
      actorId: 'owner-2',
      assetId: approvedAsset.id,
    });

    expect(retried).toEqual(approvedAsset);
    expect(assetRepo.savedAssets).toEqual([]);
    expect(auditRepo.getAll()).toEqual([]);
  });

  it('returns an already active asset without duplicate saves or audit events', async () => {
    const assetRepo = new RecordingTrainingAssetRepository();
    const auditRepo = new InMemoryAuditRepository();
    const activeAsset = makeAsset({
      id: 'asset-active-retry',
      status: 'active',
      rawText: undefined,
      scrubbedText: 'Safe active training text.',
      approvedBy: 'owner-1',
      activatedAt: new Date('2026-05-15T01:00:00Z'),
      updatedAt: new Date('2026-05-15T01:00:00Z'),
    });
    await assetRepo.save(activeAsset);
    assetRepo.savedAssets.length = 0;
    const service = new TrainingAssetService({
      assetRepo,
      privacyAuditRepo: new InMemoryPrivacyAuditRepository(),
      auditRepo,
      redaction: new TrainingAssetRedactionService(),
      now: () => new Date('2026-05-15T02:00:00Z'),
    });

    const retried = await service.activate({
      tenantId: 'tenant-1',
      actorId: 'owner-2',
      assetId: activeAsset.id,
    });

    expect(retried).toEqual(activeAsset);
    expect(assetRepo.savedAssets).toEqual([]);
    expect(auditRepo.getAll()).toEqual([]);
  });

  it('restores approval transitions when standard audit creation fails', async () => {
    const assetRepo = new RecordingTrainingAssetRepository();
    await assetRepo.save(makeAsset({
      id: 'asset-approve-audit-fail',
      status: 'redacted',
      rawText: undefined,
      scrubbedText: 'Safe redacted training text.',
    }));
    assetRepo.savedAssets.length = 0;
    const service = new TrainingAssetService({
      assetRepo,
      privacyAuditRepo: new InMemoryPrivacyAuditRepository(),
      auditRepo: new FailingAuditRepository(),
      redaction: new TrainingAssetRedactionService(),
      now: () => new Date('2026-05-15T00:00:00Z'),
    });

    await expect(service.approve({
      tenantId: 'tenant-1',
      actorId: 'owner-1',
      assetId: 'asset-approve-audit-fail',
    })).rejects.toThrow('audit unavailable');

    expect(assetRepo.savedAssets.map((asset) => asset.status)).toEqual(['approved', 'redacted']);
    await expect(assetRepo.findById('tenant-1', 'asset-approve-audit-fail')).resolves.toMatchObject({
      status: 'redacted',
    });
  });

  it('restores activation transitions when standard audit creation fails', async () => {
    const assetRepo = new RecordingTrainingAssetRepository();
    await assetRepo.save(makeAsset({
      id: 'asset-activate-audit-fail',
      status: 'approved',
      rawText: undefined,
      scrubbedText: 'Safe approved training text.',
      approvedBy: 'owner-1',
    }));
    assetRepo.savedAssets.length = 0;
    const service = new TrainingAssetService({
      assetRepo,
      privacyAuditRepo: new InMemoryPrivacyAuditRepository(),
      auditRepo: new FailingAuditRepository(),
      redaction: new TrainingAssetRedactionService(),
      now: () => new Date('2026-05-15T00:00:00Z'),
    });

    await expect(service.activate({
      tenantId: 'tenant-1',
      actorId: 'owner-1',
      assetId: 'asset-activate-audit-fail',
    })).rejects.toThrow('audit unavailable');

    expect(assetRepo.savedAssets.map((asset) => asset.status)).toEqual(['active', 'approved']);
    await expect(assetRepo.findById('tenant-1', 'asset-activate-audit-fail')).resolves.toMatchObject({
      status: 'approved',
    });
  });
});

describe('TrainingAssetService — request-transaction reuse (PR #669 review)', () => {
  function makeInput(title: string) {
    return {
      verticalType: 'hvac' as const,
      assetKind: 'prompt_context' as const,
      title,
      rawText: 'Caller has no heat.',
      labels: {},
      provenance: { source: 'tenant_admin' as const, sourceVersion: '1' },
    };
  }

  it('reuses the ambient tenant transaction instead of opening a second pool client', async () => {
    // /api routes mount withTenantTransaction(pool): the request already holds
    // a client in tenantContextStore. A second pool.connect() here would let N
    // concurrent requests starve a size-N pool (outer clients held, all
    // blocking on inner connects).
    const pool = new FakeTrainingAssetPool();
    const service = new TrainingAssetService({
      assetRepo: new InMemoryTrainingAssetRepository(),
      privacyAuditRepo: new InMemoryPrivacyAuditRepository(),
      auditRepo: new InMemoryAuditRepository(),
      redaction: new TrainingAssetRedactionService(),
      pool: pool as unknown as Pool,
      idGenerator: () => 'asset-ambient-1',
      now: () => new Date('2026-07-12T00:00:00Z'),
    });

    const ambientClient = { query: async () => ({ rows: [] }) } as unknown as PoolClient;
    const asset = await tenantContextStore.run(
      { client: ambientClient, tenantId: 'tenant-1' },
      () => service.create({ tenantId: 'tenant-1', actorId: 'user-1', input: makeInput('Ambient reuse') }),
    );

    expect(asset.id).toBe('asset-ambient-1');
    expect(pool.connectCount).toBe(0); // no second client — ambient tx reused
  });

  it('still opens its own transaction when no ambient tenant context exists', async () => {
    const pool = new FakeTrainingAssetPool();
    const service = new TrainingAssetService({
      assetRepo: new InMemoryTrainingAssetRepository(),
      privacyAuditRepo: new InMemoryPrivacyAuditRepository(),
      auditRepo: new InMemoryAuditRepository(),
      redaction: new TrainingAssetRedactionService(),
      pool: pool as unknown as Pool,
      idGenerator: () => 'asset-own-tx-1',
      now: () => new Date('2026-07-12T00:00:00Z'),
    });

    await service.create({ tenantId: 'tenant-1', actorId: 'user-1', input: makeInput('Own transaction') });
    expect(pool.connectCount).toBe(1);
    expect(pool.client.releaseCount).toBe(1);
  });

  it('does not adopt an ambient context belonging to a DIFFERENT tenant', async () => {
    const pool = new FakeTrainingAssetPool();
    const service = new TrainingAssetService({
      assetRepo: new InMemoryTrainingAssetRepository(),
      privacyAuditRepo: new InMemoryPrivacyAuditRepository(),
      auditRepo: new InMemoryAuditRepository(),
      redaction: new TrainingAssetRedactionService(),
      pool: pool as unknown as Pool,
      idGenerator: () => 'asset-cross-tenant-1',
      now: () => new Date('2026-07-12T00:00:00Z'),
    });

    const ambientClient = { query: async () => ({ rows: [] }) } as unknown as PoolClient;
    await tenantContextStore.run(
      { client: ambientClient, tenantId: 'tenant-OTHER' },
      () => service.create({ tenantId: 'tenant-1', actorId: 'user-1', input: makeInput('Cross tenant') }),
    );
    // Wrong-tenant ambient context must NOT be reused — a fresh, correctly
    // scoped transaction is opened instead.
    expect(pool.connectCount).toBe(1);
  });
});
