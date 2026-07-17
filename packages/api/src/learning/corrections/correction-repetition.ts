/**
 * WS20 — correction-repetition meta-proposals ("the AI proposes the fix itself").
 *
 * The correction loop already distills each owner edit into a structured lesson
 * and cascades it into tenant config WITHIN THE DAY (labor rate / catalog SKU
 * price / banned phrase). This module sits on top: once the owner has corrected
 * the SAME target N times (CORRECTION_REPETITION_THRESHOLD), instead of leaving
 * the durable config change as a silent within-day side effect, the AI PROPOSES
 * the durable change through the NORMAL inbox — one reviewed, owner-ratified
 * proposal (D-004: no auto-approve; the meta-proposal goes through review).
 *
 * Interaction with the applicator cascade (the one place this could be
 * redundant): `applyLessonConfig` persists the corrected price to the catalog
 * on EVERY part_price_changed lesson, so if the cascade durably STUCK the
 * repeated identical correction self-limits — the extractor's
 * `beforeCents === afterCents` guard means a second identical correction
 * produces no lesson, so the count can't grow. Reaching the threshold therefore
 * implies the catalog does NOT currently reflect the repeatedly-corrected value
 * (the owner keeps undoing the within-day cascade, or the drafts keep
 * reintroducing a price the catalog doesn't govern). The no-op guard below
 * (`currentUnitPriceCents === proposedUnitPriceCents → skip`) makes that precise:
 * we only propose in the space where the cascade's effect is absent, never
 * re-doing work it already did.
 *
 * Two variants, keyed on the lesson's normalized target:
 *   - part_price_changed (key = catalogItemId) → `update_catalog_item`
 *   - banned_phrase      (key = normalized phrase) → `create_standing_instruction`
 *
 * Pure orchestration over ports; never throws (a detection failure must never
 * break the caller's onExecuted seam — it is called failure-soft).
 */
import {
  createProposal,
  type Proposal,
  type ProposalRepository,
  type ProposalStatus,
  type ProposalType,
} from '../../proposals/proposal';
import type { CatalogItemRepository } from '../../catalog/catalog-item';
import { AuditRepository, createAuditEvent } from '../../audit/audit';
import type { Logger } from '../../logging/logger';
import { MAX_INSTRUCTION_LENGTH } from '../../instructions/standing-instructions';
import type { CorrectionLesson } from './correction-lesson';
import type { CorrectionLessonRepository } from './correction-lesson';

/** Same-target corrections required before the AI proposes the durable fix. */
export const CORRECTION_REPETITION_THRESHOLD = 3;

/** Statuses that block (or gate) a duplicate meta-proposal for the same target. */
const DEDUP_STATUSES: readonly ProposalStatus[] = ['draft', 'ready_for_review', 'rejected'];

const META_PROPOSAL_ACTOR = 'ai';

export interface DetectCorrectionRepetitionInput {
  tenantId: string;
  /** Lessons just recorded by this execution (the fresh corrections). */
  recordedLessons: CorrectionLesson[];
  /** Actor id stamped on the created proposals. Defaults to 'ai'. */
  createdBy?: string;
}

export interface DetectCorrectionRepetitionDeps {
  lessonRepo: CorrectionLessonRepository;
  proposalRepo: ProposalRepository;
  catalogRepo: CatalogItemRepository;
  auditRepo?: AuditRepository;
  logger?: Pick<Logger, 'warn'>;
  /** Override the threshold (tests). */
  threshold?: number;
}

function fmtUsd(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const rem = abs % 100;
  return rem === 0 ? `${sign}$${dollars}` : `${sign}$${dollars}.${String(rem).padStart(2, '0')}`;
}

/**
 * Decide whether an existing set of same-target meta-proposals suppresses a new
 * one. Open (draft / ready_for_review) → always suppress (one already pending).
 * Otherwise, if the most recent is rejected, suppress UNLESS the triggering
 * correction is newer than that rejection — a fresh repetition after "no"
 * re-earns the proposal; older corrections do not nag.
 */
function suppressedByExisting(existing: Proposal[], triggerAt: Date): boolean {
  const open = existing.filter(
    (p) => p.status === 'draft' || p.status === 'ready_for_review',
  );
  if (open.length > 0) return true;
  const rejected = existing.filter((p) => p.status === 'rejected');
  if (rejected.length === 0) return false;
  const latestRejection = rejected.reduce((a, b) =>
    a.updatedAt.getTime() >= b.updatedAt.getTime() ? a : b,
  );
  // Re-earn only when this correction arrived AFTER the rejection.
  return triggerAt.getTime() <= latestRejection.updatedAt.getTime();
}

async function existingForTarget(
  deps: DetectCorrectionRepetitionDeps,
  tenantId: string,
  proposalType: ProposalType,
  target: { kind: string; key: string },
): Promise<Proposal[]> {
  // Optional on the interface for fake-compat; both real repos implement it.
  if (!deps.proposalRepo.findByCorrectionTarget) return [];
  return deps.proposalRepo.findByCorrectionTarget(tenantId, proposalType, target, DEDUP_STATUSES);
}

async function persistMetaProposal(
  deps: DetectCorrectionRepetitionDeps,
  tenantId: string,
  createdBy: string,
  proposal: Proposal,
  audit: { proposalType: ProposalType; target: { kind: string; key: string }; correctionCount: number },
): Promise<Proposal> {
  // System-generated + complete → lands directly in the review queue (the
  // overdue-invoice-worker pattern). createProposal has no trust tier, so it
  // would default to 'draft'; ready_for_review surfaces it as an actionable
  // approval rather than an incomplete draft.
  const created = await deps.proposalRepo.create({ ...proposal, status: 'ready_for_review' });
  if (deps.auditRepo) {
    await deps.auditRepo.create(
      createAuditEvent({
        tenantId,
        actorId: createdBy,
        actorRole: 'system',
        eventType: 'correction_repetition.proposed',
        entityType: 'proposal',
        entityId: created.id,
        metadata: {
          proposalType: audit.proposalType,
          correctionTarget: audit.target,
          correctionCount: audit.correctionCount,
        },
      }),
    );
  }
  return created;
}

/**
 * Detect same-target repetition among freshly-recorded lessons and emit at most
 * one meta-proposal per distinct target. Returns the created proposals (empty
 * when nothing crossed the threshold or all were deduped). Never throws.
 */
export async function detectCorrectionRepetition(
  input: DetectCorrectionRepetitionInput,
  deps: DetectCorrectionRepetitionDeps,
): Promise<Proposal[]> {
  const threshold = deps.threshold ?? CORRECTION_REPETITION_THRESHOLD;
  const createdBy = input.createdBy ?? META_PROPOSAL_ACTOR;
  const emitted: Proposal[] = [];
  const handledTargets = new Set<string>();

  for (const lesson of input.recordedLessons) {
    try {
      if (lesson.payload.kind === 'part_price_changed') {
        const catalogItemId = lesson.payload.catalogItemId;
        const dedupeKey = `part_price:${catalogItemId}`;
        if (handledTargets.has(dedupeKey)) continue;
        handledTargets.add(dedupeKey);

        const count = await deps.lessonRepo.countByTarget(
          input.tenantId,
          'part_price_changed',
          catalogItemId,
        );
        if (count < threshold) continue;

        const item = await deps.catalogRepo.findById(input.tenantId, catalogItemId);
        if (!item) continue; // item gone → nothing to propose

        const proposedUnitPriceCents = lesson.payload.afterCents;
        // The catalog price the owner keeps overriding (pre-correction
        // baseline from the lesson; fall back to the live catalog).
        const currentUnitPriceCents = lesson.payload.beforeCents ?? item.unitPriceCents;
        // No-op guard: the catalog already reflects the corrected value (the
        // cascade stuck) → nothing to propose. See module header.
        if (currentUnitPriceCents === proposedUnitPriceCents) continue;

        const target = { kind: 'part_price', key: catalogItemId };
        const existing = await existingForTarget(deps, input.tenantId, 'update_catalog_item', target);
        if (suppressedByExisting(existing, lesson.createdAt)) continue;

        const proposal = createProposal({
          tenantId: input.tenantId,
          proposalType: 'update_catalog_item',
          payload: {
            catalogItemId,
            ...(lesson.payload.sku ? { sku: lesson.payload.sku } : {}),
            name: item.name,
            currentUnitPriceCents,
            proposedUnitPriceCents,
            evidence: { lessonIds: [lesson.id], correctionCount: count },
          },
          summary: `You've corrected ${item.name} to ${fmtUsd(proposedUnitPriceCents)} ${count} times — update the catalog?`,
          createdBy,
          sourceContext: {
            correctionTarget: target,
            evidence: { lessonIds: [lesson.id], correctionCount: count },
          },
        });
        emitted.push(
          await persistMetaProposal(deps, input.tenantId, createdBy, proposal, {
            proposalType: 'update_catalog_item',
            target,
            correctionCount: count,
          }),
        );
      } else if (lesson.payload.kind === 'banned_phrase') {
        const phrase = lesson.payload.phrase.trim();
        const normKey = phrase.toLowerCase();
        const dedupeKey = `banned_phrase:${normKey}`;
        if (handledTargets.has(dedupeKey)) continue;
        handledTargets.add(dedupeKey);

        const count = await deps.lessonRepo.countByTarget(
          input.tenantId,
          'banned_phrase',
          normKey,
        );
        if (count < threshold) continue;

        const target = { kind: 'banned_phrase', key: normKey };
        const existing = await existingForTarget(
          deps,
          input.tenantId,
          'create_standing_instruction',
          target,
        );
        if (suppressedByExisting(existing, lesson.createdAt)) continue;

        const instruction = `Never say "${phrase}" to customers.`.slice(0, MAX_INSTRUCTION_LENGTH);
        const proposal = createProposal({
          tenantId: input.tenantId,
          proposalType: 'create_standing_instruction',
          payload: { instruction },
          summary: `You've removed "${phrase}" ${count} times — make it a standing rule?`,
          createdBy,
          sourceContext: {
            correctionTarget: target,
            evidence: { lessonIds: [lesson.id], correctionCount: count },
          },
        });
        emitted.push(
          await persistMetaProposal(deps, input.tenantId, createdBy, proposal, {
            proposalType: 'create_standing_instruction',
            target,
            correctionCount: count,
          }),
        );
      }
    } catch (err) {
      // Failure-isolated per lesson: a dedup / create error on one target must
      // never abort the others (or the caller's onExecuted seam).
      deps.logger?.warn('correction-repetition: meta-proposal detection failed for a lesson', {
        tenantId: input.tenantId,
        lessonId: lesson.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return emitted;
}
