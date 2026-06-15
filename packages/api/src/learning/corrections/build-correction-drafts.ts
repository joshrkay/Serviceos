/**
 * N-009 / P2-038 — Shared drafted-vs-executed → structured-lesson bridge.
 *
 * The executor's `onExecuted` hook records structured correction lessons, and
 * the proposal-correction RAG worker emits training chunks; BOTH start from the
 * same raw material — the AI's drafted proposal payload vs. the as-executed
 * payload. This module owns the ONE place that turns those two payloads into
 * the typed `DeltaEntry[]` + line-item view the structured extractor needs, so
 * the structured path and the RAG path agree on how an edit is read.
 *
 * Pure and deterministic (no I/O): the caller supplies the loaded payloads and
 * the current tenant config snapshot, and gets back `CorrectionLessonDraft[]`.
 * Conservative by construction — `extractCorrectionLessons` only emits a lesson
 * for a clear, single-pattern edit, so a clean rubber-stamp (empty diff) yields
 * `[]`.
 */
import { computeInvoiceDeltas, type DeltaEntry } from '../../ai/evaluation/invoice-edit-delta';
import type { LineItem, LineItemCategory } from '../../shared/billing-engine';
import {
  extractCorrectionLessons,
  type CorrectionLessonDraft,
  type ExtractorConfigSnapshot,
  type ExtractorLineItem,
  type TemplateResolver,
} from './correction-extractor';

/** The two payloads an edit is read from. */
export interface ProposalPayloadDiffInput {
  /** Immutable AI-drafted proposal payload. */
  drafted: Record<string, unknown>;
  /** As-executed payload (dispatcher edits, when an edit surface exists). */
  executed: Record<string, unknown>;
}

/**
 * Coerce a raw payload's `lineItems` (untyped JSONB) into the snapshot shape
 * `computeInvoiceDeltas` consumes. Only the fields the delta + extractor read
 * are projected; anything missing is left undefined (the extractor degrades,
 * never guesses).
 */
function toSnapshotLineItems(raw: unknown): LineItem[] {
  if (!Array.isArray(raw)) return [];
  const items: LineItem[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    if (typeof o.id !== 'string') continue;
    items.push({
      id: o.id,
      description: typeof o.description === 'string' ? o.description : '',
      category: o.category as LineItemCategory | undefined,
      quantity: typeof o.quantity === 'number' ? o.quantity : 0,
      unitPriceCents: typeof o.unitPriceCents === 'number' ? o.unitPriceCents : 0,
      totalCents: typeof o.totalCents === 'number' ? o.totalCents : 0,
      sortOrder: typeof o.sortOrder === 'number' ? o.sortOrder : 0,
      taxable: o.taxable === true,
    });
  }
  return items;
}

/** Project the EXECUTED line items into the extractor's minimal view. */
function toExtractorLineItems(raw: unknown): ExtractorLineItem[] {
  if (!Array.isArray(raw)) return [];
  const items: ExtractorLineItem[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    if (typeof o.id !== 'string') continue;
    items.push({
      id: o.id,
      category: o.category as LineItemCategory | undefined,
      // catalogItemId is carried on payloads that bind a line to a SKU; absent
      // bindings stay uncatalogued and produce no part_price_changed lesson.
      ...(typeof o.catalogItemId === 'string' ? { catalogItemId: o.catalogItemId } : {}),
      ...(typeof o.sku === 'string' ? { sku: o.sku } : {}),
      ...(typeof o.description === 'string' ? { description: o.description } : {}),
    });
  }
  return items;
}

export interface BuildCorrectionDraftsOptions {
  /** Resolves a reclass target category → template; default: no scope lessons. */
  resolveTemplate?: TemplateResolver;
  /** Optional explicit rejection reason that may name a banned phrase. */
  rejectionReason?: string;
}

/**
 * Turn a drafted-vs-executed payload pair + the current config snapshot into
 * structured lesson drafts. Returns `[]` when the edit is a clean approval or
 * when no rule fires cleanly.
 */
export function buildCorrectionLessonDrafts(
  diff: ProposalPayloadDiffInput,
  config: ExtractorConfigSnapshot,
  options: BuildCorrectionDraftsOptions = {},
): CorrectionLessonDraft[] {
  const draftedItems = toSnapshotLineItems(diff.drafted.lineItems);
  const executedItems = toSnapshotLineItems(diff.executed.lineItems);

  const deltas: DeltaEntry[] = computeInvoiceDeltas(
    {
      lineItems: draftedItems,
      discountCents:
        typeof diff.drafted.discountCents === 'number' ? diff.drafted.discountCents : undefined,
      taxRateBps: typeof diff.drafted.taxRateBps === 'number' ? diff.drafted.taxRateBps : undefined,
      customerMessage:
        typeof diff.drafted.customerMessage === 'string' ? diff.drafted.customerMessage : undefined,
    },
    {
      lineItems: executedItems,
      discountCents:
        typeof diff.executed.discountCents === 'number' ? diff.executed.discountCents : undefined,
      taxRateBps:
        typeof diff.executed.taxRateBps === 'number' ? diff.executed.taxRateBps : undefined,
      customerMessage:
        typeof diff.executed.customerMessage === 'string'
          ? diff.executed.customerMessage
          : undefined,
    },
  );

  if (deltas.length === 0 && !options.rejectionReason) return [];

  return extractCorrectionLessons({
    deltas,
    // Classify against the EXECUTED (final) line items — that's the state the
    // owner left the proposal in.
    lineItems: toExtractorLineItems(diff.executed.lineItems),
    config,
    ...(options.rejectionReason ? { rejectionReason: options.rejectionReason } : {}),
    ...(options.resolveTemplate ? { resolveTemplate: options.resolveTemplate } : {}),
  });
}
