/**
 * N-009 / P2-038 — Correction-loop extractor.
 *
 * Turns the typed deltas of an owner's proposal edit (computed by
 * `ai/evaluation/invoice-edit-delta.ts`) into STRUCTURED LESSON DRAFTS.
 *
 * Conservatism is the whole point (review prompt: "does not infer lessons
 * from edits that lack a clear pattern"). Each rule below either produces a
 * single unambiguous lesson or nothing:
 *
 *   labor_rate_changed  — exactly one coherent new per-hour rate across the
 *                         labor lines that changed. If two labor lines were
 *                         edited to DIFFERENT prices, the intent is unclear →
 *                         no lesson.
 *   part_price_changed  — a material line whose price changed AND which is
 *                         bound to a catalog SKU (catalogItemId). An
 *                         uncatalogued line can't be grounded to a tenant
 *                         price, so we never guess one → no lesson.
 *   banned_phrase       — a description/message edit (or a rejection reason)
 *                         that cleanly REMOVES a contiguous phrase. If the new
 *                         text isn't the old text with one segment cut, the
 *                         removal isn't clear → no lesson.
 *   scope_reclassified  — a line/category reclass with a recognized target
 *                         template. No template mapping → no lesson.
 *
 * Pure and deterministic — no I/O, no LLM. The caller supplies the current
 * config snapshot (labor rate, SKU prices, banned phrases, template weights)
 * so each draft carries an exact `{ before, after }` for reversibility; the
 * applicator (`lesson-applicator.ts`) performs the cascade.
 */
import type { DeltaEntry } from '../../ai/evaluation/invoice-edit-delta';
import type { LineItemCategory } from '../../shared/billing-engine';
import type {
  CorrectionLessonType,
  CorrectionLessonPayload,
} from '@ai-service-os/shared';

/** Minimal line-item view the extractor needs to classify a changed line. */
export interface ExtractorLineItem {
  id: string;
  category?: LineItemCategory;
  /** Catalog SKU binding, when the line was catalog-grounded. */
  catalogItemId?: string;
  sku?: string;
  description?: string;
}

/** Current tenant config the cascade reverses against (all cents are integer). */
export interface ExtractorConfigSnapshot {
  /** Tenant default labor rate, or null if unset (degrades, never guesses). */
  laborRateCents: number | null;
  /** Current catalog price per SKU id, keyed by catalogItemId. */
  skuPriceCents: Record<string, number>;
  /** Current brand-voice negative-prompt phrases. */
  bannedPhrases: string[];
  /** Current vertical-pack template weights keyed `${packId}:${templateKey}`. */
  templateWeights: Record<string, number>;
}

/**
 * A category reclass delta names old/new categories; the caller maps a target
 * category to a concrete (packId, templateKey). Returning null skips the
 * lesson (no recognized template to nudge).
 */
export type TemplateResolver = (
  newCategory: string,
) => { packId: string; templateKey: string } | null;

export interface ExtractCorrectionContext {
  deltas: DeltaEntry[];
  /** All line items in the EDITED (new) revision, by id. */
  lineItems: ExtractorLineItem[];
  config: ExtractorConfigSnapshot;
  /** Optional free-text rejection reason that may name a banned phrase. */
  rejectionReason?: string;
  /** Resolves a reclass target → template; default returns null (no lesson). */
  resolveTemplate?: TemplateResolver;
  /** Weight delta applied on a reclass (default +0.1, clamped to [0,1]). */
  reclassWeightStep?: number;
}

export interface CorrectionLessonDraft {
  lessonType: CorrectionLessonType;
  summary: string;
  payload: CorrectionLessonPayload;
}

const DEFAULT_RECLASS_STEP = 0.1;

function fmtUsd(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const rem = abs % 100;
  return rem === 0 ? `${sign}$${dollars}` : `${sign}$${dollars}.${String(rem).padStart(2, '0')}`;
}

/**
 * Extract a contiguous removed phrase when `next` is `prev` with exactly one
 * segment cut out (prefix preserved + suffix preserved). Returns null when the
 * removal isn't a single clean cut (rewrites, additions, multi-cut edits) —
 * those are ambiguous and must not produce a lesson.
 */
export function extractRemovedPhrase(prev: string, next: string): string | null {
  const a = prev.trim();
  const b = next.trim();
  if (a.length === 0 || b.length >= a.length) return null;

  // Longest common prefix.
  let p = 0;
  while (p < b.length && a[p] === b[p]) p++;
  // Longest common suffix (not overlapping the prefix on either string).
  let s = 0;
  while (
    s < b.length - p &&
    s < a.length - p &&
    a[a.length - 1 - s] === b[b.length - 1 - s]
  ) {
    s++;
  }

  // `next` must be exactly prefix + suffix of `prev` (one removed middle).
  if (p + s !== b.length) return null;
  const removed = a.slice(p, a.length - s).trim();
  // Require a meaningful phrase (a word or more), not stray punctuation/space.
  if (removed.length < 2 || !/[a-z0-9]/i.test(removed)) return null;
  return removed;
}

/**
 * Extract structured lesson drafts from an edit. Conservative: returns [] when
 * no rule fires cleanly. At most one lesson per type (labor rate / each SKU /
 * each removed phrase / each reclass target).
 */
export function extractCorrectionLessons(
  ctx: ExtractCorrectionContext,
): CorrectionLessonDraft[] {
  const byId = new Map(ctx.lineItems.map((li) => [li.id, li]));
  const drafts: CorrectionLessonDraft[] = [];

  // ---- labor_rate_changed -------------------------------------------------
  const laborPriceChanges = ctx.deltas.filter(
    (d) =>
      d.type === 'price_changed' &&
      d.lineItemId !== undefined &&
      byId.get(d.lineItemId)?.category === 'labor',
  );
  if (laborPriceChanges.length > 0) {
    const newRates = new Set(laborPriceChanges.map((d) => Number(d.newValue)));
    // Clear pattern = all edited labor lines agree on ONE new rate.
    if (newRates.size === 1) {
      const afterCents = Number(laborPriceChanges[0].newValue);
      if (Number.isInteger(afterCents) && afterCents >= 0 && afterCents !== ctx.config.laborRateCents) {
        const beforeCents = ctx.config.laborRateCents;
        drafts.push({
          lessonType: 'labor_rate_changed',
          summary: `Labor rate updated to ${fmtUsd(afterCents)}/hr${
            beforeCents !== null ? ` (was ${fmtUsd(beforeCents)})` : ''
          }.`,
          payload: { kind: 'labor_rate_changed', beforeCents, afterCents },
        });
      }
    }
  }

  // ---- part_price_changed -------------------------------------------------
  const seenSkus = new Set<string>();
  for (const d of ctx.deltas) {
    if (d.type !== 'price_changed' || d.lineItemId === undefined) continue;
    const li = byId.get(d.lineItemId);
    if (!li || li.category !== 'material' || !li.catalogItemId) continue; // uncatalogued → no guess
    if (seenSkus.has(li.catalogItemId)) continue;
    const afterCents = Number(d.newValue);
    if (!Number.isInteger(afterCents) || afterCents < 0) continue;
    const beforeCents = ctx.config.skuPriceCents[li.catalogItemId] ?? null;
    if (beforeCents === afterCents) continue;
    seenSkus.add(li.catalogItemId);
    drafts.push({
      lessonType: 'part_price_changed',
      summary: `Price for "${li.description ?? li.sku ?? li.catalogItemId}" updated to ${fmtUsd(
        afterCents,
      )}${beforeCents !== null ? ` (was ${fmtUsd(beforeCents)})` : ''}.`,
      payload: {
        kind: 'part_price_changed',
        catalogItemId: li.catalogItemId,
        ...(li.sku ? { sku: li.sku } : {}),
        beforeCents,
        afterCents,
      },
    });
  }

  // ---- banned_phrase ------------------------------------------------------
  const phraseCandidates: string[] = [];
  for (const d of ctx.deltas) {
    if (d.type !== 'description_changed' && d.type !== 'message_changed') continue;
    const removed = extractRemovedPhrase(String(d.oldValue ?? ''), String(d.newValue ?? ''));
    if (removed) phraseCandidates.push(removed);
  }
  // A rejection reason of the form `ban: <phrase>` is an explicit, clear signal.
  if (ctx.rejectionReason) {
    const m = ctx.rejectionReason.match(/(?:ban|never say|don'?t say)\s*:?\s*["“]?([^"”]+)["”]?/i);
    if (m && m[1].trim().length >= 2) phraseCandidates.push(m[1].trim());
  }
  const phrasesAdded = new Set<string>();
  let runningPhrases = [...ctx.config.bannedPhrases];
  for (const phrase of phraseCandidates) {
    const norm = phrase.trim();
    const already = runningPhrases.some((p) => p.toLowerCase() === norm.toLowerCase());
    if (already || phrasesAdded.has(norm.toLowerCase())) continue;
    const beforePhrases = [...runningPhrases];
    const afterPhrases = [...runningPhrases, norm];
    runningPhrases = afterPhrases;
    phrasesAdded.add(norm.toLowerCase());
    drafts.push({
      lessonType: 'banned_phrase',
      summary: `Added "${norm}" to the do-not-say list.`,
      payload: { kind: 'banned_phrase', phrase: norm, beforePhrases, afterPhrases },
    });
  }

  // ---- scope_reclassified -------------------------------------------------
  const resolveTemplate = ctx.resolveTemplate;
  if (resolveTemplate) {
    const step = ctx.reclassWeightStep ?? DEFAULT_RECLASS_STEP;
    const seenTemplates = new Set<string>();
    for (const d of ctx.deltas) {
      if (d.type !== 'category_changed') continue;
      const newCategory = String(d.newValue ?? '');
      if (!newCategory) continue;
      const target = resolveTemplate(newCategory);
      if (!target) continue; // no recognized template → no lesson
      const key = `${target.packId}:${target.templateKey}`;
      if (seenTemplates.has(key)) continue;
      seenTemplates.add(key);
      const beforeWeight = ctx.config.templateWeights[key] ?? 0;
      const afterWeight = Math.min(1, Math.max(0, Number((beforeWeight + step).toFixed(4))));
      if (afterWeight === beforeWeight) continue;
      drafts.push({
        lessonType: 'scope_reclassified',
        summary: `Leaning more on the "${target.templateKey}" template for ${newCategory} jobs.`,
        payload: {
          kind: 'scope_reclassified',
          packId: target.packId,
          templateKey: target.templateKey,
          beforeWeight,
          afterWeight,
        },
      });
    }
  }

  return drafts;
}
