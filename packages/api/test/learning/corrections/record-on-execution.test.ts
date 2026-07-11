import { describe, it, expect, beforeEach } from 'vitest';
import type { LineItem } from '../../../src/shared/billing-engine';
import type { Proposal, ProposalRepository } from '../../../src/proposals/proposal';
import type {
  ProposalExecution,
  ProposalExecutionRepository,
} from '../../../src/proposals/proposal-execution';
import type { SettingsRepository, TenantSettings } from '../../../src/settings/settings';
import { InMemoryAuditRepository } from '../../../src/audit/audit';
import { InMemoryCorrectionLessonRepository } from '../../../src/learning/corrections/correction-lesson';
import { FakeConfigPorts } from '../../../src/learning/corrections/lesson-applicator';
import {
  InMemoryCatalogItemRepository,
  type CatalogItem,
} from '../../../src/catalog/catalog-item';
import {
  recordCorrectionLessonsOnExecution,
  type RecordOnExecutionDeps,
} from '../../../src/learning/corrections/record-on-execution';

const TENANT = 'tenant-u7';
const PROPOSAL = 'prop-u7';
const OWNER = 'owner-u7';
const EXECUTED_AT = new Date('2026-06-15T18:00:00Z');

function li(over: Partial<LineItem> & { id: string }): LineItem {
  return {
    description: 'Labor',
    category: 'labor',
    quantity: 1,
    unitPriceCents: 11500,
    totalCents: 11500,
    sortOrder: 0,
    taxable: true,
    ...over,
  };
}

function catalogItem(over: Partial<CatalogItem> & { id: string; unitPriceCents: number }): CatalogItem {
  return {
    tenantId: TENANT,
    name: 'Smoke Detector',
    description: '',
    category: 'Materials',
    unit: 'each',
    productServiceType: 'product',
    archivedAt: null,
    createdAt: EXECUTED_AT.toISOString(),
    updatedAt: EXECUTED_AT.toISOString(),
    ...over,
  };
}

function buildDeps(opts: {
  draftedItems: LineItem[];
  executedItems: LineItem[];
  executionStatus?: 'succeeded' | 'failed';
  laborRateCents?: number | null;
  catalogItems?: CatalogItem[];
}): {
  deps: RecordOnExecutionDeps;
  ports: FakeConfigPorts;
  lessonRepo: InMemoryCorrectionLessonRepository;
  catalogRepo: InMemoryCatalogItemRepository;
} {
  const proposalRepo = {
    findById: async (t: string, id: string) =>
      t === TENANT && id === PROPOSAL
        ? ({
            id: PROPOSAL,
            tenantId: TENANT,
            proposalType: 'draft_estimate',
            status: 'executed',
            payload: { lineItems: opts.draftedItems },
          } as unknown as Proposal)
        : null,
  } as unknown as ProposalRepository;

  const proposalExecutionRepo = {
    findLatestByProposal: async (t: string, id: string) =>
      t === TENANT && id === PROPOSAL
        ? ({
            id: 'exec-1',
            tenantId: TENANT,
            proposalId: PROPOSAL,
            status: opts.executionStatus ?? 'succeeded',
            executedPayload: { lineItems: opts.executedItems },
            executedBy: OWNER,
            executedAt: EXECUTED_AT,
          } as unknown as ProposalExecution)
        : null,
  } as unknown as ProposalExecutionRepository;

  const settingsRepo = {
    findByTenant: async () =>
      ({
        tenantId: TENANT,
        timezone: 'America/New_York',
        laborRateCentsPerHour: opts.laborRateCents ?? 11500,
        brandVoice: { banned_phrases: [] },
      } as unknown as TenantSettings),
  } as unknown as SettingsRepository;

  const lessonRepo = new InMemoryCorrectionLessonRepository();
  const ports = new FakeConfigPorts({ laborRateCents: opts.laborRateCents ?? 11500 });
  const auditRepo = new InMemoryAuditRepository();
  const catalogRepo = new InMemoryCatalogItemRepository();
  for (const item of opts.catalogItems ?? []) {
    // seed synchronously enough for the test's first await
    void catalogRepo.create(item);
  }

  return {
    deps: {
      proposalRepo,
      proposalExecutionRepo,
      settingsRepo,
      lessonRepo,
      catalogRepo,
      ports,
      auditRepo,
    },
    ports,
    lessonRepo,
    catalogRepo,
  };
}

describe('U7 — recordCorrectionLessonsOnExecution', () => {
  let auditRepo: InMemoryAuditRepository;
  beforeEach(() => {
    auditRepo = new InMemoryAuditRepository();
  });

  it('records a labor_rate_changed lesson and cascades the rate forward', async () => {
    const { deps, ports, lessonRepo } = buildDeps({
      draftedItems: [li({ id: 'l1', unitPriceCents: 11500 })],
      executedItems: [li({ id: 'l1', unitPriceCents: 13500 })],
      laborRateCents: 11500,
    });

    const lessons = await recordCorrectionLessonsOnExecution(
      { tenantId: TENANT, proposalId: PROPOSAL },
      deps,
    );

    expect(lessons).toHaveLength(1);
    expect(lessons[0].lessonType).toBe('labor_rate_changed');
    expect(lessons[0].localDate).toBe('2026-06-15'); // executedAt in America/New_York
    // Forward cascade hit the ports.
    expect(ports.laborRateCents).toBe(13500);
    // Persisted + applied.
    const applied = await lessonRepo.findAppliedForDay(TENANT, '2026-06-15');
    expect(applied).toHaveLength(1);
  });

  it('extracts a labor lesson from an ESTIMATE edit (unitPrice field, not unitPriceCents)', async () => {
    // Estimate payloads carry integer cents in `unitPrice`; the diff must still
    // see the change (regression guard: computeInvoiceDeltas only reads
    // unitPriceCents, so unnormalized estimate edits produced no lesson).
    const estLine = (cents: number) =>
      ({ id: 'l1', description: 'Labor', category: 'labor', quantity: 1, unitPrice: cents } as unknown as LineItem);
    const { deps, ports, lessonRepo } = buildDeps({
      draftedItems: [estLine(11500)],
      executedItems: [estLine(13500)],
      laborRateCents: 11500,
    });

    const lessons = await recordCorrectionLessonsOnExecution(
      { tenantId: TENANT, proposalId: PROPOSAL },
      deps,
    );

    expect(lessons).toHaveLength(1);
    expect(lessons[0].lessonType).toBe('labor_rate_changed');
    expect(ports.laborRateCents).toBe(13500);
    expect(await lessonRepo.findAppliedForDay(TENANT, '2026-06-15')).toHaveLength(1);
  });

  it('records nothing for a clean execution (no diff)', async () => {
    const { deps, ports } = buildDeps({
      draftedItems: [li({ id: 'l1', unitPriceCents: 11500 })],
      executedItems: [li({ id: 'l1', unitPriceCents: 11500 })],
    });
    const lessons = await recordCorrectionLessonsOnExecution(
      { tenantId: TENANT, proposalId: PROPOSAL },
      deps,
    );
    expect(lessons).toHaveLength(0);
    expect(ports.laborRateCents).toBe(11500);
  });

  it('records nothing for a non-line-item proposal', async () => {
    const { deps } = buildDeps({ draftedItems: [], executedItems: [] });
    const lessons = await recordCorrectionLessonsOnExecution(
      { tenantId: TENANT, proposalId: PROPOSAL },
      deps,
    );
    expect(lessons).toHaveLength(0);
  });

  it('records nothing for a failed execution', async () => {
    const { deps } = buildDeps({
      draftedItems: [li({ id: 'l1', unitPriceCents: 11500 })],
      executedItems: [li({ id: 'l1', unitPriceCents: 13500 })],
      executionStatus: 'failed',
    });
    const lessons = await recordCorrectionLessonsOnExecution(
      { tenantId: TENANT, proposalId: PROPOSAL },
      deps,
    );
    expect(lessons).toHaveLength(0);
  });

  it('records a part_price_changed lesson from a catalog-bound material price edit', async () => {
    // WS20a: the SKU binding (catalogItemId) now flows into the extractor and
    // the catalog price is pre-loaded as `beforeCents`, so a material line edit
    // grounds to a real part-price lesson (previously skuPriceCents was {} and
    // catalogItemId was stripped → the lesson never fired).
    const partLine = (cents: number) =>
      ({
        id: 'p1',
        description: 'Smoke Detector',
        category: 'material',
        quantity: 1,
        unitPriceCents: cents,
        totalCents: cents,
        sortOrder: 1,
        taxable: true,
        catalogItemId: 'cat-smoke',
        sku: 'SD-100',
      } as unknown as LineItem);

    const { deps, ports, lessonRepo } = buildDeps({
      draftedItems: [partLine(10000)],
      executedItems: [partLine(8900)],
      catalogItems: [catalogItem({ id: 'cat-smoke', unitPriceCents: 10000, name: 'Smoke Detector' })],
    });

    const lessons = await recordCorrectionLessonsOnExecution(
      { tenantId: TENANT, proposalId: PROPOSAL },
      deps,
    );

    expect(lessons).toHaveLength(1);
    expect(lessons[0].lessonType).toBe('part_price_changed');
    expect(lessons[0].payload).toMatchObject({
      kind: 'part_price_changed',
      catalogItemId: 'cat-smoke',
      sku: 'SD-100',
      beforeCents: 10000,
      afterCents: 8900,
    });
    // Cascade updated the catalog SKU price forward.
    expect(ports.skuPriceCents['cat-smoke']).toBe(8900);
    expect(await lessonRepo.findAppliedForDay(TENANT, '2026-06-15')).toHaveLength(1);
  });

  it('records no part_price lesson for an UNCATALOGUED material edit (no catalogItemId)', async () => {
    const partLine = (cents: number) =>
      ({
        id: 'p1',
        description: 'Random part',
        category: 'material',
        quantity: 1,
        unitPriceCents: cents,
        totalCents: cents,
        sortOrder: 1,
        taxable: true,
      } as unknown as LineItem);

    const { deps } = buildDeps({
      draftedItems: [partLine(10000)],
      executedItems: [partLine(8900)],
    });

    const lessons = await recordCorrectionLessonsOnExecution(
      { tenantId: TENANT, proposalId: PROPOSAL },
      deps,
    );
    // No SKU binding → no tenant price to ground → no guess, no lesson.
    expect(lessons).toHaveLength(0);
  });

  it('records no part_price lesson when the edited price equals the current catalog price', async () => {
    const partLine = (cents: number) =>
      ({
        id: 'p1',
        description: 'Smoke Detector',
        category: 'material',
        quantity: 1,
        unitPriceCents: cents,
        totalCents: cents,
        sortOrder: 1,
        taxable: true,
        catalogItemId: 'cat-smoke',
      } as unknown as LineItem);

    // Drafted differs from executed, but executed already equals the catalog
    // price → nothing new to learn (self-limiting; the cascade already stuck).
    const { deps } = buildDeps({
      draftedItems: [partLine(10000)],
      executedItems: [partLine(8900)],
      catalogItems: [catalogItem({ id: 'cat-smoke', unitPriceCents: 8900 })],
    });

    const lessons = await recordCorrectionLessonsOnExecution(
      { tenantId: TENANT, proposalId: PROPOSAL },
      deps,
    );
    expect(lessons).toHaveLength(0);
  });

  it('does not duplicate the labor lesson when the edited rate equals the existing default', async () => {
    // Drafted differs from executed, but executed equals the current tenant
    // default → no NEW rate to learn.
    const { deps } = buildDeps({
      draftedItems: [li({ id: 'l1', unitPriceCents: 9000 })],
      executedItems: [li({ id: 'l1', unitPriceCents: 11500 })],
      laborRateCents: 11500,
    });
    const lessons = await recordCorrectionLessonsOnExecution(
      { tenantId: TENANT, proposalId: PROPOSAL },
      deps,
    );
    expect(lessons).toHaveLength(0);
  });
});
