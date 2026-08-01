/**
 * N-009 / P2-038 — Correction-loop domain (repo + helpers).
 *
 * The repository persists `correction_lessons` (tenant_id + FORCE RLS,
 * migration 180). The orchestration layer (`recordCorrectionLesson` /
 * `undoCorrectionLesson`) lives in `apply-undo.ts`; this file owns the data
 * shape, the in-memory repo (tests + non-DB callers), and the tenant-local
 * day helper that scopes forward application.
 */
import { DateTime } from 'luxon';
import type {
  CorrectionLesson,
  CorrectionLessonType,
  CorrectionLessonPayload,
} from '@ai-service-os/shared';

export type {
  CorrectionLesson,
  CorrectionLessonType,
  CorrectionLessonStatus,
  CorrectionLessonPayload,
  LaborRatePayload,
  PartPricePayload,
  BannedPhrasePayload,
  ScopeReclassifiedPayload,
} from '@ai-service-os/shared';

export interface CreateCorrectionLessonInput {
  id: string;
  tenantId: string;
  lessonType: CorrectionLessonType;
  sourceProposalId: string;
  ownerId: string;
  summary: string;
  payload: CorrectionLessonPayload;
  localDate: string;
}

export interface CorrectionLessonRepository {
  create(lesson: CorrectionLesson): Promise<CorrectionLesson>;
  findById(tenantId: string, id: string): Promise<CorrectionLesson | null>;
  /**
   * Lessons that are still APPLIED (not reverted) and fall on `localDate`.
   * Drives both forward application and the digest "what I learned today".
   * Ordered oldest → newest so a later lesson on the same field wins
   * (last-writer) when callers fold them in order.
   */
  findAppliedForDay(tenantId: string, localDate: string): Promise<CorrectionLesson[]>;
  /**
   * Lessons recorded from a given proposal — the reverse lookup that lets an
   * undo of that proposal reverse every cascaded config change it produced.
   * Includes already-reverted lessons (undo is idempotent on each).
   */
  findBySourceProposal(tenantId: string, sourceProposalId: string): Promise<CorrectionLesson[]>;
  /** Mark a lesson reverted; returns the updated row or null if not found. */
  markReverted(tenantId: string, id: string, revertedAt: Date): Promise<CorrectionLesson | null>;
  /**
   * WS20 — count lessons of `lessonType` whose TARGET identity equals
   * `targetKey`, across ALL statuses (applied + reverted). The repetition
   * signal counts every correction event, including within-day cascades the
   * owner later undid. Target identity per type:
   *   - part_price_changed → payload.catalogItemId (exact match)
   *   - banned_phrase      → payload.phrase (case-insensitive, trimmed)
   * Other lesson types have no single-target concept and return 0.
   * Drives the correction-repetition threshold that emits a meta-proposal.
   */
  countByTarget(
    tenantId: string,
    lessonType: CorrectionLessonType,
    targetKey: string,
  ): Promise<number>;
}

/**
 * Extract the TARGET identity a repetition is counted by, from a lesson's
 * payload. Shared by the in-memory + Pg repos (and the detector) so the two
 * never drift on what "the same correction" means. Returns null for lesson
 * types that have no single-target concept.
 */
export function correctionLessonTargetKey(
  payload: CorrectionLessonPayload,
): { lessonType: CorrectionLessonType; key: string } | null {
  switch (payload.kind) {
    case 'part_price_changed':
      return { lessonType: 'part_price_changed', key: payload.catalogItemId };
    case 'banned_phrase':
      return { lessonType: 'banned_phrase', key: payload.phrase.trim().toLowerCase() };
    default:
      return null;
  }
}

/**
 * Tenant-local calendar day (YYYY-MM-DD) for an instant. Storage stays UTC;
 * forward application and the digest window are scoped to this local day so a
 * 11pm-Pacific edit doesn't bleed into the next UTC date.
 */
export function localDateFor(instant: Date, timezone: string): string {
  const dt = DateTime.fromJSDate(instant, { zone: timezone });
  const iso = dt.toISODate();
  if (!iso) {
    throw new Error(`Invalid timezone for correction lesson localDate: ${timezone}`);
  }
  return iso;
}

export function buildCorrectionLesson(input: CreateCorrectionLessonInput): CorrectionLesson {
  return {
    id: input.id,
    tenantId: input.tenantId,
    lessonType: input.lessonType,
    status: 'applied',
    sourceProposalId: input.sourceProposalId,
    ownerId: input.ownerId,
    summary: input.summary,
    payload: input.payload,
    localDate: input.localDate,
    createdAt: new Date(),
    revertedAt: null,
  };
}

export class InMemoryCorrectionLessonRepository implements CorrectionLessonRepository {
  private lessons = new Map<string, CorrectionLesson>();

  async create(lesson: CorrectionLesson): Promise<CorrectionLesson> {
    this.lessons.set(lesson.id, structuredClone(lesson));
    return structuredClone(lesson);
  }

  async findById(tenantId: string, id: string): Promise<CorrectionLesson | null> {
    const l = this.lessons.get(id);
    if (!l || l.tenantId !== tenantId) return null;
    return structuredClone(l);
  }

  async findAppliedForDay(tenantId: string, localDate: string): Promise<CorrectionLesson[]> {
    return Array.from(this.lessons.values())
      .filter(
        (l) => l.tenantId === tenantId && l.status === 'applied' && l.localDate === localDate,
      )
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((l) => structuredClone(l));
  }

  async findBySourceProposal(
    tenantId: string,
    sourceProposalId: string,
  ): Promise<CorrectionLesson[]> {
    return Array.from(this.lessons.values())
      .filter((l) => l.tenantId === tenantId && l.sourceProposalId === sourceProposalId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((l) => structuredClone(l));
  }

  async markReverted(
    tenantId: string,
    id: string,
    revertedAt: Date,
  ): Promise<CorrectionLesson | null> {
    const l = this.lessons.get(id);
    if (!l || l.tenantId !== tenantId) return null;
    const updated: CorrectionLesson = { ...l, status: 'reverted', revertedAt };
    this.lessons.set(id, updated);
    return structuredClone(updated);
  }

  async countByTarget(
    tenantId: string,
    lessonType: CorrectionLessonType,
    targetKey: string,
  ): Promise<number> {
    let count = 0;
    for (const l of this.lessons.values()) {
      if (l.tenantId !== tenantId || l.lessonType !== lessonType) continue;
      const target = correctionLessonTargetKey(l.payload);
      if (target && target.lessonType === lessonType && target.key === normalizeTargetKey(lessonType, targetKey)) {
        count++;
      }
    }
    return count;
  }
}

/**
 * Normalize a caller-supplied target key to match `correctionLessonTargetKey`'s
 * stored form: banned-phrase targets are compared case-insensitively + trimmed;
 * catalog SKU ids are exact.
 */
export function normalizeTargetKey(lessonType: CorrectionLessonType, key: string): string {
  return lessonType === 'banned_phrase' ? key.trim().toLowerCase() : key;
}
