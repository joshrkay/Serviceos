import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'crypto';
import {
  InMemoryProposalRepository,
  type Proposal,
} from '../../../src/proposals/proposal';
import { InMemoryAuditRepository } from '../../../src/audit/audit';
import {
  InMemoryCatalogItemRepository,
  type CatalogItem,
} from '../../../src/catalog/catalog-item';
import {
  InMemoryCorrectionLessonRepository,
  buildCorrectionLesson,
  type CorrectionLesson,
} from '../../../src/learning/corrections/correction-lesson';
import {
  detectCorrectionRepetition,
  CORRECTION_REPETITION_THRESHOLD,
} from '../../../src/learning/corrections/correction-repetition';

const TENANT = 'tenant-ws20';
const CATALOG_ID = '11111111-1111-4111-8111-111111111111';
const LOCAL_DATE = '2026-07-11';

function catalogItem(over: Partial<CatalogItem> & { unitPriceCents: number }): CatalogItem {
  return {
    id: CATALOG_ID,
    tenantId: TENANT,
    name: 'Smoke Detector',
    description: '',
    category: 'Materials',
    unit: 'each',
    productServiceType: 'product',
    archivedAt: null,
    createdAt: '2026-07-01T00:00:00Z',
    updatedAt: '2026-07-01T00:00:00Z',
    ...over,
  };
}

function partPriceLesson(opts: {
  catalogItemId?: string;
  beforeCents: number | null;
  afterCents: number;
  createdAt?: Date;
  sku?: string;
}): CorrectionLesson {
  const lesson = buildCorrectionLesson({
    id: randomUUID(),
    tenantId: TENANT,
    lessonType: 'part_price_changed',
    sourceProposalId: randomUUID(),
    ownerId: 'owner-1',
    summary: 'price change',
    payload: {
      kind: 'part_price_changed',
      catalogItemId: opts.catalogItemId ?? CATALOG_ID,
      ...(opts.sku ? { sku: opts.sku } : {}),
      beforeCents: opts.beforeCents,
      afterCents: opts.afterCents,
    },
    localDate: LOCAL_DATE,
  });
  return opts.createdAt ? { ...lesson, createdAt: opts.createdAt } : lesson;
}

function bannedPhraseLesson(phrase: string, createdAt?: Date): CorrectionLesson {
  const lesson = buildCorrectionLesson({
    id: randomUUID(),
    tenantId: TENANT,
    lessonType: 'banned_phrase',
    sourceProposalId: randomUUID(),
    ownerId: 'owner-1',
    summary: 'phrase removed',
    payload: { kind: 'banned_phrase', phrase, beforePhrases: [], afterPhrases: [phrase] },
    localDate: LOCAL_DATE,
  });
  return createdAt ? { ...lesson, createdAt } : lesson;
}

async function makeDeps(catalogPriceCents = 10000) {
  const lessonRepo = new InMemoryCorrectionLessonRepository();
  const proposalRepo = new InMemoryProposalRepository();
  const catalogRepo = new InMemoryCatalogItemRepository();
  const auditRepo = new InMemoryAuditRepository();
  await catalogRepo.create(catalogItem({ unitPriceCents: catalogPriceCents }));
  return { lessonRepo, proposalRepo, catalogRepo, auditRepo };
}

/** Seed N part-price lessons for the same SKU; return the latest (trigger). */
async function seedPartPriceLessons(
  lessonRepo: InMemoryCorrectionLessonRepository,
  n: number,
  afterCents: number,
  beforeCents: number | null,
): Promise<CorrectionLesson> {
  let latest!: CorrectionLesson;
  for (let i = 0; i < n; i++) {
    latest = partPriceLesson({
      beforeCents,
      afterCents,
      createdAt: new Date(`2026-07-11T0${i}:00:00Z`),
    });
    await lessonRepo.create(latest);
  }
  return latest;
}

describe('WS20 — detectCorrectionRepetition (catalog variant)', () => {
  it('threshold constant is 3', () => {
    expect(CORRECTION_REPETITION_THRESHOLD).toBe(3);
  });

  it('does NOTHING at 2 same-target corrections', async () => {
    const { lessonRepo, proposalRepo, catalogRepo, auditRepo } = await makeDeps(10000);
    const trigger = await seedPartPriceLessons(lessonRepo, 2, 8900, 10000);

    const emitted = await detectCorrectionRepetition(
      { tenantId: TENANT, recordedLessons: [trigger] },
      { lessonRepo, proposalRepo, catalogRepo, auditRepo },
    );

    expect(emitted).toHaveLength(0);
    expect(await proposalRepo.findByStatus(TENANT, 'ready_for_review')).toHaveLength(0);
  });

  it('fires at EXACTLY 3 same-target corrections with the right payload shape', async () => {
    const { lessonRepo, proposalRepo, catalogRepo, auditRepo } = await makeDeps(10000);
    const trigger = await seedPartPriceLessons(lessonRepo, 3, 8900, 10000);

    const emitted = await detectCorrectionRepetition(
      { tenantId: TENANT, recordedLessons: [trigger] },
      { lessonRepo, proposalRepo, catalogRepo, auditRepo },
    );

    expect(emitted).toHaveLength(1);
    const p = emitted[0];
    expect(p.proposalType).toBe('update_catalog_item');
    expect(p.status).toBe('ready_for_review');
    expect(p.createdBy).toBe('ai');
    expect(p.payload).toMatchObject({
      catalogItemId: CATALOG_ID,
      name: 'Smoke Detector',
      currentUnitPriceCents: 10000,
      proposedUnitPriceCents: 8900,
      evidence: { lessonIds: [trigger.id], correctionCount: 3 },
    });
    expect(p.summary).toContain('$89');
    expect(p.summary).toContain('3 times');
    expect((p.sourceContext as { correctionTarget?: unknown }).correctionTarget).toEqual({
      kind: 'part_price',
      key: CATALOG_ID,
    });
    // Surfaced in the review queue (naturally counted by the digest).
    expect(await proposalRepo.findByStatus(TENANT, 'ready_for_review')).toHaveLength(1);
    // Audited.
    const audits = await auditRepo.findByEntity(TENANT, 'proposal', p.id);
    expect(audits.some((a) => a.eventType === 'correction_repetition.proposed')).toBe(true);
  });

  it('no-op guard: suppresses when the catalog ALREADY reflects the corrected price', async () => {
    // The applicator cascade stuck: catalog == proposed. Nothing to change, so
    // the meta-proposal must not fire (complement the cascade, never double-fire).
    const { lessonRepo, proposalRepo, catalogRepo, auditRepo } = await makeDeps(8900);
    // beforeCents null → detector falls back to the live catalog (8900) == after.
    const trigger = await seedPartPriceLessons(lessonRepo, 3, 8900, null);

    const emitted = await detectCorrectionRepetition(
      { tenantId: TENANT, recordedLessons: [trigger] },
      { lessonRepo, proposalRepo, catalogRepo, auditRepo },
    );
    expect(emitted).toHaveLength(0);
  });

  it('dedup: suppresses while an OPEN meta-proposal for the same SKU exists', async () => {
    const { lessonRepo, proposalRepo, catalogRepo, auditRepo } = await makeDeps(10000);
    const trigger = await seedPartPriceLessons(lessonRepo, 3, 8900, 10000);

    // First detection emits one.
    const first = await detectCorrectionRepetition(
      { tenantId: TENANT, recordedLessons: [trigger] },
      { lessonRepo, proposalRepo, catalogRepo, auditRepo },
    );
    expect(first).toHaveLength(1);

    // A fresh correction arrives; the open proposal suppresses a duplicate.
    const trigger2 = partPriceLesson({
      beforeCents: 10000,
      afterCents: 8900,
      createdAt: new Date('2026-07-11T09:00:00Z'),
    });
    await lessonRepo.create(trigger2);
    const second = await detectCorrectionRepetition(
      { tenantId: TENANT, recordedLessons: [trigger2] },
      { lessonRepo, proposalRepo, catalogRepo, auditRepo },
    );
    expect(second).toHaveLength(0);
    expect(await proposalRepo.findByStatus(TENANT, 'ready_for_review')).toHaveLength(1);
  });

  it('rejected: suppresses until a NEWER correction re-earns it', async () => {
    const { lessonRepo, proposalRepo, catalogRepo, auditRepo } = await makeDeps(10000);
    const trigger = await seedPartPriceLessons(lessonRepo, 3, 8900, 10000);
    const first = await detectCorrectionRepetition(
      { tenantId: TENANT, recordedLessons: [trigger] },
      { lessonRepo, proposalRepo, catalogRepo, auditRepo },
    );
    expect(first).toHaveLength(1);

    // Owner rejects it. InMemory stamps updatedAt = now, so anchor the
    // stale/fresh corrections RELATIVE to this moment (deterministic ±1h).
    const rejectionMoment = Date.now();
    const rejected = await proposalRepo.updateStatus(TENANT, first[0].id, 'rejected');
    expect(rejected?.status).toBe('rejected');

    // A correction that predates the rejection does NOT re-earn.
    const staleTrigger = partPriceLesson({
      beforeCents: 10000,
      afterCents: 8900,
      createdAt: new Date(rejectionMoment - 3_600_000),
    });
    await lessonRepo.create(staleTrigger);
    const stale = await detectCorrectionRepetition(
      { tenantId: TENANT, recordedLessons: [staleTrigger] },
      { lessonRepo, proposalRepo, catalogRepo, auditRepo },
    );
    expect(stale).toHaveLength(0);

    // A FRESH correction after the rejection re-earns the proposal.
    const freshTrigger = partPriceLesson({
      beforeCents: 10000,
      afterCents: 8900,
      createdAt: new Date(rejectionMoment + 3_600_000),
    });
    await lessonRepo.create(freshTrigger);
    const fresh = await detectCorrectionRepetition(
      { tenantId: TENANT, recordedLessons: [freshTrigger] },
      { lessonRepo, proposalRepo, catalogRepo, auditRepo },
    );
    expect(fresh).toHaveLength(1);
  });

  it('counts only the SAME catalogItemId (different SKUs do not aggregate)', async () => {
    const { lessonRepo, proposalRepo, catalogRepo, auditRepo } = await makeDeps(10000);
    const otherId = '22222222-2222-4222-8222-222222222222';
    await catalogRepo.create(catalogItem({ id: otherId, unitPriceCents: 5000, name: 'Other' }));
    // 2 for CATALOG_ID, 2 for otherId → neither reaches 3.
    await lessonRepo.create(partPriceLesson({ beforeCents: 10000, afterCents: 8900 }));
    const trigA = partPriceLesson({ beforeCents: 10000, afterCents: 8900 });
    await lessonRepo.create(trigA);
    await lessonRepo.create(partPriceLesson({ catalogItemId: otherId, beforeCents: 5000, afterCents: 4000 }));
    const trigB = partPriceLesson({ catalogItemId: otherId, beforeCents: 5000, afterCents: 4000 });
    await lessonRepo.create(trigB);

    const emitted = await detectCorrectionRepetition(
      { tenantId: TENANT, recordedLessons: [trigA, trigB] },
      { lessonRepo, proposalRepo, catalogRepo, auditRepo },
    );
    expect(emitted).toHaveLength(0);
  });
});

describe('WS20 — detectCorrectionRepetition (standing-instruction variant)', () => {
  it('fires a create_standing_instruction proposal at 3 same-phrase removals', async () => {
    const { lessonRepo, proposalRepo, catalogRepo, auditRepo } = await makeDeps();
    let trigger!: CorrectionLesson;
    for (let i = 0; i < 3; i++) {
      // Case/whitespace variants normalize to the same target.
      const phrase = i === 1 ? '  No Worries  ' : 'no worries';
      trigger = bannedPhraseLesson(phrase, new Date(`2026-07-11T0${i}:00:00Z`));
      await lessonRepo.create(trigger);
    }

    const emitted = await detectCorrectionRepetition(
      { tenantId: TENANT, recordedLessons: [trigger] },
      { lessonRepo, proposalRepo, catalogRepo, auditRepo },
    );

    expect(emitted).toHaveLength(1);
    const p = emitted[0];
    expect(p.proposalType).toBe('create_standing_instruction');
    expect(p.status).toBe('ready_for_review');
    expect(p.payload.instruction).toContain('no worries');
    expect((p.sourceContext as { correctionTarget?: unknown }).correctionTarget).toEqual({
      kind: 'banned_phrase',
      key: 'no worries',
    });
  });

  it('does nothing at 2 same-phrase removals', async () => {
    const { lessonRepo, proposalRepo, catalogRepo, auditRepo } = await makeDeps();
    let trigger!: CorrectionLesson;
    for (let i = 0; i < 2; i++) {
      trigger = bannedPhraseLesson('no worries', new Date(`2026-07-11T0${i}:00:00Z`));
      await lessonRepo.create(trigger);
    }
    const emitted = await detectCorrectionRepetition(
      { tenantId: TENANT, recordedLessons: [trigger] },
      { lessonRepo, proposalRepo, catalogRepo, auditRepo },
    );
    expect(emitted).toHaveLength(0);
  });
});
