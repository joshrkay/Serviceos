/**
 * N-009 / P2-038 — Correction-loop unit tests.
 *
 * Covers: each of the four lesson types extracted from a representative edit;
 * ambiguous edits produce NO lesson (conservative); record applies config
 * forward + audits; undo reverses config + audits.
 */
import { describe, it, expect } from 'vitest';
import {
  extractCorrectionLessons,
  extractRemovedPhrase,
  type ExtractorConfigSnapshot,
  type ExtractorLineItem,
} from '../../src/learning/corrections/correction-extractor';
import type { DeltaEntry } from '../../src/ai/evaluation/invoice-edit-delta';
import {
  FakeConfigPorts,
  applyLessonConfig,
  revertLessonConfig,
} from '../../src/learning/corrections/lesson-applicator';
import {
  recordCorrectionLessons,
  undoCorrectionLesson,
} from '../../src/learning/corrections/apply-undo';
import {
  InMemoryCorrectionLessonRepository,
  localDateFor,
} from '../../src/learning/corrections/correction-lesson';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import {
  CorrectionLessonSchema,
  CorrectionLessonPayloadSchema,
} from '@ai-service-os/shared';

function baseConfig(overrides: Partial<ExtractorConfigSnapshot> = {}): ExtractorConfigSnapshot {
  return {
    laborRateCents: null,
    skuPriceCents: {},
    bannedPhrases: [],
    templateWeights: {},
    ...overrides,
  };
}

describe('extractCorrectionLessons — the four lesson types', () => {
  it('labor_rate_changed: a labor line price edit updates the tenant rate', () => {
    const lineItems: ExtractorLineItem[] = [{ id: 'li-1', category: 'labor' }];
    const deltas: DeltaEntry[] = [
      { type: 'price_changed', lineItemId: 'li-1', field: 'unitPriceCents', oldValue: 11500, newValue: 13500 },
    ];
    const drafts = extractCorrectionLessons({
      deltas,
      lineItems,
      config: baseConfig({ laborRateCents: 11500 }),
    });
    expect(drafts).toHaveLength(1);
    expect(drafts[0].lessonType).toBe('labor_rate_changed');
    expect(drafts[0].payload).toMatchObject({
      kind: 'labor_rate_changed',
      beforeCents: 11500,
      afterCents: 13500,
    });
    // Integer cents preserved end-to-end.
    expect(CorrectionLessonPayloadSchema.safeParse(drafts[0].payload).success).toBe(true);
  });

  it('part_price_changed: a catalog-bound material line edit updates the SKU price', () => {
    const lineItems: ExtractorLineItem[] = [
      { id: 'li-2', category: 'material', catalogItemId: 'sku-9', sku: 'FILTER-20', description: '20x25 filter' },
    ];
    const deltas: DeltaEntry[] = [
      { type: 'price_changed', lineItemId: 'li-2', field: 'unitPriceCents', oldValue: 1800, newValue: 2200 },
    ];
    const drafts = extractCorrectionLessons({
      deltas,
      lineItems,
      config: baseConfig({ skuPriceCents: { 'sku-9': 1800 } }),
    });
    expect(drafts).toHaveLength(1);
    expect(drafts[0].lessonType).toBe('part_price_changed');
    expect(drafts[0].payload).toMatchObject({
      kind: 'part_price_changed',
      catalogItemId: 'sku-9',
      sku: 'FILTER-20',
      beforeCents: 1800,
      afterCents: 2200,
    });
  });

  it('banned_phrase: a description edit that cleanly removes a phrase', () => {
    const lineItems: ExtractorLineItem[] = [{ id: 'li-3', category: 'labor' }];
    const deltas: DeltaEntry[] = [
      {
        type: 'description_changed',
        lineItemId: 'li-3',
        field: 'description',
        oldValue: 'Diagnostic fee — cheapest in town guaranteed',
        newValue: 'Diagnostic fee',
      },
    ];
    const drafts = extractCorrectionLessons({ deltas, lineItems, config: baseConfig() });
    expect(drafts).toHaveLength(1);
    expect(drafts[0].lessonType).toBe('banned_phrase');
    expect(drafts[0].payload).toMatchObject({
      kind: 'banned_phrase',
      phrase: '— cheapest in town guaranteed',
      beforePhrases: [],
    });
  });

  it('banned_phrase: an explicit rejection reason names the phrase', () => {
    const drafts = extractCorrectionLessons({
      deltas: [],
      lineItems: [],
      config: baseConfig(),
      rejectionReason: 'ban: lowest price guaranteed',
    });
    expect(drafts).toHaveLength(1);
    expect(drafts[0].payload).toMatchObject({ kind: 'banned_phrase', phrase: 'lowest price guaranteed' });
  });

  it('scope_reclassified: a category change nudges the resolved template weight', () => {
    const lineItems: ExtractorLineItem[] = [{ id: 'li-4', category: 'material' }];
    const deltas: DeltaEntry[] = [
      { type: 'category_changed', lineItemId: 'li-4', field: 'category', oldValue: 'material', newValue: 'equipment' },
    ];
    const drafts = extractCorrectionLessons({
      deltas,
      lineItems,
      config: baseConfig({ templateWeights: { 'hvac:equipment_install': 0.5 } }),
      resolveTemplate: (cat) =>
        cat === 'equipment' ? { packId: 'hvac', templateKey: 'equipment_install' } : null,
    });
    expect(drafts).toHaveLength(1);
    expect(drafts[0].lessonType).toBe('scope_reclassified');
    expect(drafts[0].payload).toMatchObject({
      kind: 'scope_reclassified',
      packId: 'hvac',
      templateKey: 'equipment_install',
      beforeWeight: 0.5,
      afterWeight: 0.6,
    });
  });
});

describe('extractCorrectionLessons — conservative: ambiguous edits produce no lesson', () => {
  it('two labor lines edited to DIFFERENT rates → no labor lesson', () => {
    const lineItems: ExtractorLineItem[] = [
      { id: 'a', category: 'labor' },
      { id: 'b', category: 'labor' },
    ];
    const deltas: DeltaEntry[] = [
      { type: 'price_changed', lineItemId: 'a', oldValue: 11500, newValue: 12000 },
      { type: 'price_changed', lineItemId: 'b', oldValue: 11500, newValue: 13000 },
    ];
    const drafts = extractCorrectionLessons({ deltas, lineItems, config: baseConfig({ laborRateCents: 11500 }) });
    expect(drafts).toHaveLength(0);
  });

  it('material price edit with NO catalog binding → no part lesson (cannot ground)', () => {
    const lineItems: ExtractorLineItem[] = [{ id: 'a', category: 'material' }]; // no catalogItemId
    const deltas: DeltaEntry[] = [{ type: 'price_changed', lineItemId: 'a', oldValue: 1000, newValue: 1500 }];
    const drafts = extractCorrectionLessons({ deltas, lineItems, config: baseConfig() });
    expect(drafts).toHaveLength(0);
  });

  it('a description REWRITE (not a clean removal) → no banned-phrase lesson', () => {
    const lineItems: ExtractorLineItem[] = [{ id: 'a', category: 'labor' }];
    const deltas: DeltaEntry[] = [
      {
        type: 'description_changed',
        lineItemId: 'a',
        oldValue: 'Cheap fast service',
        newValue: 'Professional thorough service',
      },
    ];
    const drafts = extractCorrectionLessons({ deltas, lineItems, config: baseConfig() });
    expect(drafts).toHaveLength(0);
  });

  it('category change with NO recognized template → no scope lesson', () => {
    const lineItems: ExtractorLineItem[] = [{ id: 'a', category: 'material' }];
    const deltas: DeltaEntry[] = [
      { type: 'category_changed', lineItemId: 'a', oldValue: 'material', newValue: 'other' },
    ];
    const drafts = extractCorrectionLessons({
      deltas,
      lineItems,
      config: baseConfig(),
      resolveTemplate: () => null, // nothing recognized
    });
    expect(drafts).toHaveLength(0);
  });

  it('a price edit that lands on the SAME value → no lesson (no-op)', () => {
    const lineItems: ExtractorLineItem[] = [{ id: 'a', category: 'labor' }];
    const deltas: DeltaEntry[] = [{ type: 'price_changed', lineItemId: 'a', oldValue: 12000, newValue: 12000 }];
    const drafts = extractCorrectionLessons({ deltas, lineItems, config: baseConfig({ laborRateCents: 12000 }) });
    expect(drafts).toHaveLength(0);
  });

  it('no deltas at all → no lessons', () => {
    expect(extractCorrectionLessons({ deltas: [], lineItems: [], config: baseConfig() })).toEqual([]);
  });
});

describe('extractRemovedPhrase', () => {
  it('extracts a contiguous middle/suffix removal', () => {
    expect(extractRemovedPhrase('Service call fee waived today', 'Service call fee')).toBe('waived today');
  });
  it('returns null for a rewrite', () => {
    expect(extractRemovedPhrase('alpha beta', 'gamma delta')).toBeNull();
  });
  it('returns null when text was ADDED, not removed', () => {
    expect(extractRemovedPhrase('short', 'short and longer')).toBeNull();
  });
});

describe('applyLessonConfig / revertLessonConfig — undo reverses config', () => {
  it('labor rate: apply sets after, undo restores before', async () => {
    const ports = new FakeConfigPorts({ laborRateCents: 11500 });
    const payload = CorrectionLessonPayloadSchema.parse({
      kind: 'labor_rate_changed',
      beforeCents: 11500,
      afterCents: 14000,
    });
    await applyLessonConfig('t1', payload, ports);
    expect(ports.laborRateCents).toBe(14000);
    await revertLessonConfig('t1', payload, ports);
    expect(ports.laborRateCents).toBe(11500);
  });

  it('banned phrases: apply adds, undo restores the prior list exactly', async () => {
    const ports = new FakeConfigPorts({ bannedPhrases: ['no refunds'] });
    const payload = CorrectionLessonPayloadSchema.parse({
      kind: 'banned_phrase',
      phrase: 'cheapest in town',
      beforePhrases: ['no refunds'],
      afterPhrases: ['no refunds', 'cheapest in town'],
    });
    await applyLessonConfig('t1', payload, ports);
    expect(ports.bannedPhrases).toEqual(['no refunds', 'cheapest in town']);
    await revertLessonConfig('t1', payload, ports);
    expect(ports.bannedPhrases).toEqual(['no refunds']);
  });

  it('part price: undo with a null before leaves the SKU untouched', async () => {
    const ports = new FakeConfigPorts({ skuPriceCents: { 'sku-1': 2200 } });
    const payload = CorrectionLessonPayloadSchema.parse({
      kind: 'part_price_changed',
      catalogItemId: 'sku-1',
      beforeCents: null,
      afterCents: 2200,
    });
    await revertLessonConfig('t1', payload, ports);
    expect(ports.skuPriceCents['sku-1']).toBe(2200); // unchanged, no guess
  });
});

describe('recordCorrectionLessons / undoCorrectionLesson — full orchestration', () => {
  const tenantId = 'tenant-A';
  const ownerId = 'owner-1';

  it('persists, applies config forward, and emits an apply audit per lesson', async () => {
    const repo = new InMemoryCorrectionLessonRepository();
    const ports = new FakeConfigPorts({ laborRateCents: 11500 });
    const auditRepo = new InMemoryAuditRepository();

    const drafts = extractCorrectionLessons({
      deltas: [{ type: 'price_changed', lineItemId: 'li-1', oldValue: 11500, newValue: 13500 }],
      lineItems: [{ id: 'li-1', category: 'labor' }],
      config: baseConfig({ laborRateCents: 11500 }),
    });

    const recorded = await recordCorrectionLessons(
      { tenantId, sourceProposalId: 'prop-1', ownerId, localDate: '2026-06-14', drafts },
      { repository: repo, ports, auditRepo },
    );

    expect(recorded).toHaveLength(1);
    expect(CorrectionLessonSchema.safeParse(recorded[0]).success).toBe(true);
    // Forward application happened.
    expect(ports.laborRateCents).toBe(13500);
    // Surfaced for the day.
    const forDay = await repo.findAppliedForDay(tenantId, '2026-06-14');
    expect(forDay).toHaveLength(1);
    // Audit emitted.
    const audits = auditRepo.getAll().filter((a) => a.eventType === 'correction_lesson.applied');
    expect(audits).toHaveLength(1);
    expect(audits[0].entityId).toBe(recorded[0].id);
  });

  it('undo reverses cascaded config, marks reverted, audits, and drops from the day', async () => {
    const repo = new InMemoryCorrectionLessonRepository();
    const ports = new FakeConfigPorts({ laborRateCents: 11500 });
    const auditRepo = new InMemoryAuditRepository();

    const drafts = extractCorrectionLessons({
      deltas: [{ type: 'price_changed', lineItemId: 'li-1', oldValue: 11500, newValue: 13500 }],
      lineItems: [{ id: 'li-1', category: 'labor' }],
      config: baseConfig({ laborRateCents: 11500 }),
    });
    const [lesson] = await recordCorrectionLessons(
      { tenantId, sourceProposalId: 'prop-1', ownerId, localDate: '2026-06-14', drafts },
      { repository: repo, ports, auditRepo },
    );
    expect(ports.laborRateCents).toBe(13500);

    const reverted = await undoCorrectionLesson(
      { tenantId, lessonId: lesson.id, ownerId },
      { repository: repo, ports, auditRepo },
    );
    expect(reverted?.status).toBe('reverted');
    expect(ports.laborRateCents).toBe(11500); // config rolled back
    expect(await repo.findAppliedForDay(tenantId, '2026-06-14')).toHaveLength(0);
    const undoAudits = auditRepo.getAll().filter((a) => a.eventType === 'correction_lesson.reverted');
    expect(undoAudits).toHaveLength(1);
  });

  it('undo is idempotent — a second undo does not re-audit or re-revert', async () => {
    const repo = new InMemoryCorrectionLessonRepository();
    const ports = new FakeConfigPorts({ laborRateCents: 11500 });
    const auditRepo = new InMemoryAuditRepository();
    const drafts = extractCorrectionLessons({
      deltas: [{ type: 'price_changed', lineItemId: 'li-1', oldValue: 11500, newValue: 13500 }],
      lineItems: [{ id: 'li-1', category: 'labor' }],
      config: baseConfig({ laborRateCents: 11500 }),
    });
    const [lesson] = await recordCorrectionLessons(
      { tenantId, sourceProposalId: 'prop-1', ownerId, localDate: '2026-06-14', drafts },
      { repository: repo, ports, auditRepo },
    );
    await undoCorrectionLesson({ tenantId, lessonId: lesson.id, ownerId }, { repository: repo, ports, auditRepo });
    await undoCorrectionLesson({ tenantId, lessonId: lesson.id, ownerId }, { repository: repo, ports, auditRepo });
    expect(auditRepo.getAll().filter((a) => a.eventType === 'correction_lesson.reverted')).toHaveLength(1);
  });

  it('cross-tenant: a lesson from tenant A is invisible to tenant B', async () => {
    const repo = new InMemoryCorrectionLessonRepository();
    const ports = new FakeConfigPorts();
    const auditRepo = new InMemoryAuditRepository();
    const drafts = extractCorrectionLessons({
      deltas: [{ type: 'price_changed', lineItemId: 'li-1', oldValue: 11500, newValue: 13500 }],
      lineItems: [{ id: 'li-1', category: 'labor' }],
      config: baseConfig({ laborRateCents: 11500 }),
    });
    const [lesson] = await recordCorrectionLessons(
      { tenantId: 'A', sourceProposalId: 'p', ownerId, localDate: '2026-06-14', drafts },
      { repository: repo, ports, auditRepo },
    );
    expect(await repo.findById('B', lesson.id)).toBeNull();
    expect(await repo.findAppliedForDay('B', '2026-06-14')).toHaveLength(0);
  });
});

describe('localDateFor — tenant-local day window', () => {
  it('an 11pm-Pacific instant maps to the local (not UTC) date', () => {
    // 2026-06-15T05:30:00Z is 2026-06-14 22:30 in America/Los_Angeles.
    const instant = new Date('2026-06-15T05:30:00Z');
    expect(localDateFor(instant, 'America/Los_Angeles')).toBe('2026-06-14');
    expect(localDateFor(instant, 'UTC')).toBe('2026-06-15');
  });
});
