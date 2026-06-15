/**
 * N-009 / P2-038 — Unit tests for the shared drafted-vs-executed → lesson
 * bridge (`buildCorrectionLessonDrafts`) and the production ConfigPorts
 * (`createPgConfigPorts`). Both are the pure/wiring seams that connect the
 * executor's onExecuted hook to the structured correction loop.
 */
import { describe, it, expect } from 'vitest';
import { buildCorrectionLessonDrafts } from '../../src/learning/corrections/build-correction-drafts';
import type { ExtractorConfigSnapshot } from '../../src/learning/corrections/correction-extractor';
import { createPgConfigPorts } from '../../src/learning/corrections/pg-config-ports';
import { InMemorySettingsRepository } from '../../src/settings/settings';
import {
  InMemoryCatalogItemRepository,
  createCatalogItem,
} from '../../src/catalog/catalog-item';
import { CorrectionLessonPayloadSchema } from '@ai-service-os/shared';

function baseConfig(overrides: Partial<ExtractorConfigSnapshot> = {}): ExtractorConfigSnapshot {
  return {
    laborRateCents: null,
    skuPriceCents: {},
    bannedPhrases: [],
    templateWeights: {},
    ...overrides,
  };
}

function line(over: Record<string, unknown> = {}) {
  return {
    id: 'li-1',
    description: 'Standard labor',
    category: 'labor',
    quantity: 1,
    unitPriceCents: 11500,
    totalCents: 11500,
    sortOrder: 0,
    taxable: true,
    ...over,
  };
}

describe('buildCorrectionLessonDrafts — drafted-vs-executed payload bridge', () => {
  it('a labor-line price edit between drafted and executed yields a labor_rate lesson', () => {
    const drafts = buildCorrectionLessonDrafts(
      { drafted: { lineItems: [line()] }, executed: { lineItems: [line({ unitPriceCents: 13500 })] } },
      baseConfig({ laborRateCents: 11500 }),
    );
    expect(drafts).toHaveLength(1);
    expect(drafts[0].lessonType).toBe('labor_rate_changed');
    expect(drafts[0].payload).toMatchObject({
      kind: 'labor_rate_changed',
      beforeCents: 11500,
      afterCents: 13500,
    });
    // Integer cents preserved end-to-end through the JSONB projection.
    expect(CorrectionLessonPayloadSchema.safeParse(drafts[0].payload).success).toBe(true);
  });

  it('a clean rubber-stamp (identical payloads) yields no lessons', () => {
    const drafts = buildCorrectionLessonDrafts(
      { drafted: { lineItems: [line()] }, executed: { lineItems: [line()] } },
      baseConfig({ laborRateCents: 11500 }),
    );
    expect(drafts).toEqual([]);
  });

  it('a catalog-bound material price edit yields a part_price lesson (carries catalogItemId)', () => {
    const draftedLine = line({
      id: 'li-2',
      category: 'material',
      catalogItemId: 'sku-9',
      sku: 'FILTER-20',
      description: '20x25 filter',
      unitPriceCents: 1800,
    });
    const drafts = buildCorrectionLessonDrafts(
      {
        drafted: { lineItems: [draftedLine] },
        executed: { lineItems: [{ ...draftedLine, unitPriceCents: 2200 }] },
      },
      baseConfig({ skuPriceCents: { 'sku-9': 1800 } }),
    );
    expect(drafts).toHaveLength(1);
    expect(drafts[0].payload).toMatchObject({
      kind: 'part_price_changed',
      catalogItemId: 'sku-9',
      beforeCents: 1800,
      afterCents: 2200,
    });
  });

  it('an uncatalogued material edit (no catalogItemId) produces no lesson — never guesses', () => {
    const draftedLine = line({ id: 'li-3', category: 'material', unitPriceCents: 1000 });
    const drafts = buildCorrectionLessonDrafts(
      {
        drafted: { lineItems: [draftedLine] },
        executed: { lineItems: [{ ...draftedLine, unitPriceCents: 1500 }] },
      },
      baseConfig(),
    );
    expect(drafts).toEqual([]);
  });

  it('a document-level customerMessage edit that cleanly removes a phrase yields a banned_phrase lesson', () => {
    const drafts = buildCorrectionLessonDrafts(
      {
        drafted: { lineItems: [line()], customerMessage: 'Thanks — cheapest in town guaranteed' },
        executed: { lineItems: [line()], customerMessage: 'Thanks' },
      },
      baseConfig(),
    );
    expect(drafts).toHaveLength(1);
    expect(drafts[0].lessonType).toBe('banned_phrase');
  });

  it('an explicit rejectionReason names a banned phrase even with no line deltas', () => {
    const drafts = buildCorrectionLessonDrafts(
      { drafted: { lineItems: [line()] }, executed: { lineItems: [line()] } },
      baseConfig(),
      { rejectionReason: 'ban: lowest price guaranteed' },
    );
    expect(drafts).toHaveLength(1);
    expect(drafts[0].payload).toMatchObject({ kind: 'banned_phrase', phrase: 'lowest price guaranteed' });
  });

  it('missing/garbage lineItems on a payload degrade to no lessons (never throws)', () => {
    expect(buildCorrectionLessonDrafts({ drafted: {}, executed: {} }, baseConfig())).toEqual([]);
    expect(
      buildCorrectionLessonDrafts(
        { drafted: { lineItems: 'nope' as unknown }, executed: { lineItems: null as unknown } },
        baseConfig(),
      ),
    ).toEqual([]);
  });
});

describe('createPgConfigPorts — production cascade over real repos', () => {
  it('setLaborRateCents writes labor_rate_cents_per_hour on tenant_settings', async () => {
    const settingsRepo = new InMemorySettingsRepository();
    const catalogRepo = new InMemoryCatalogItemRepository();
    await settingsRepo.create({
      id: 's1',
      tenantId: 't1',
      businessName: 'Acme',
      timezone: 'UTC',
      estimatePrefix: 'EST-',
      invoicePrefix: 'INV-',
      nextEstimateNumber: 1,
      nextInvoiceNumber: 1,
      defaultPaymentTermDays: 30,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const ports = createPgConfigPorts({ settingsRepo, catalogRepo });

    await ports.setLaborRateCents('t1', 13500);
    expect((await settingsRepo.findByTenant('t1'))?.laborRateCentsPerHour).toBe(13500);

    // null clears the rate (undo-to-unset path).
    await ports.setLaborRateCents('t1', null);
    expect((await settingsRepo.findByTenant('t1'))?.laborRateCentsPerHour).toBeNull();
  });

  it('setSkuPriceCents updates the catalog item unit price', async () => {
    const settingsRepo = new InMemorySettingsRepository();
    const catalogRepo = new InMemoryCatalogItemRepository();
    const item = createCatalogItem({
      tenantId: 't1',
      name: 'Filter',
      category: 'Materials',
      unit: 'each',
      unitPriceCents: 1800,
    });
    await catalogRepo.create(item);
    const ports = createPgConfigPorts({ settingsRepo, catalogRepo });

    await ports.setSkuPriceCents('t1', item.id, 2200);
    expect((await catalogRepo.findById('t1', item.id))?.unitPriceCents).toBe(2200);
  });

  it('setBannedPhrases merges into brand_voice without clobbering other brand-voice fields', async () => {
    const settingsRepo = new InMemorySettingsRepository();
    const catalogRepo = new InMemoryCatalogItemRepository();
    await settingsRepo.create({
      id: 's1',
      tenantId: 't1',
      businessName: 'Acme',
      timezone: 'UTC',
      estimatePrefix: 'EST-',
      invoicePrefix: 'INV-',
      nextEstimateNumber: 1,
      nextInvoiceNumber: 1,
      defaultPaymentTermDays: 30,
      brandVoice: { formality: 'professional' },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const ports = createPgConfigPorts({ settingsRepo, catalogRepo });

    await ports.setBannedPhrases('t1', ['cheapest in town']);
    const after = await settingsRepo.findByTenant('t1');
    expect(after?.brandVoice?.banned_phrases).toEqual(['cheapest in town']);
    // existing brand-voice field is preserved.
    expect(after?.brandVoice?.formality).toBe('professional');
  });

  it('setTemplateWeight is a logged no-op (no store yet) — does not throw and logs', async () => {
    const settingsRepo = new InMemorySettingsRepository();
    const catalogRepo = new InMemoryCatalogItemRepository();
    const warnings: unknown[] = [];
    const ports = createPgConfigPorts({
      settingsRepo,
      catalogRepo,
      logger: { warn: (msg, meta) => warnings.push({ msg, meta }) },
    });
    await expect(ports.setTemplateWeight('t1', 'hvac', 'equipment_install', 0.6)).resolves.toBeUndefined();
    expect(warnings).toHaveLength(1);
  });
});
