/**
 * `lookup_materials` voice skill (Task 9, 2026-08-07 tradesperson plan) —
 * owner/technician asks to hear the pending shopping list ("what parts do
 * I need?", "read me the shopping list", "what materials are open on the
 * Patel job?").
 *
 * Tenant-scoped, read-only. Reads Task 8's `material_items` substrate
 * (src/materials/material-item.ts) via `MaterialItemRepository.listPending`
 * and summarizes the OLDEST-CREATED (quality-review M4 — Task 8's contract
 * is oldest-created-first) up to `MAX_ITEMS_SPOKEN` (5) items by
 * description + quantity, plus vendor/needed-by when the caller stated
 * them. Optionally scoped to one job when the caller's spoken jobReference
 * resolved to a verified `jobId` (JOB_REF_INTENTS membership — see
 * entity-resolution.ts); an unresolved spoken job reference is refused by
 * the CALLER (`workers/voice-lookup-answer.ts`'s `lookup_materials` case),
 * never silently widened to the whole tenant list here.
 *
 * No permission gate: unlike `lookup_leads`/`lookup_catalog`, there is
 * deliberately NO entry for this intent in `LOOKUP_REQUIRED_PERMISSION`
 * (workers/voice-lookup-answer.ts) — any authenticated operator, technician
 * included, may hear the shopping list.
 *
 * ── Bounded fetch, not "load everything and slice" (quality-review I4) ────
 *
 * `listPending` is called with `limit: MAX_ITEMS_SPOKEN + 1` — ONE extra
 * row beyond what's ever spoken, fetched purely to detect "more exist"
 * without a second COUNT query. This is a DELIBERATE divergence from
 * `lookup_catalog`, whose skill returns the tenant's WHOLE catalog and lets
 * the WORKER slice it (comment: "programmatic consumers need every item,
 * not the TTS-capped names") — there is no non-TTS consumer of the pending
 * shopping list today, and a shopping list is append-mostly (only
 * `markPurchased` prunes it), so an unbounded `SELECT *` here would load
 * every pending row for the tenant just to speak 5 of them, and that only
 * gets worse over a tenant's lifetime. If a future consumer needs more
 * than `MAX_ITEMS_SPOKEN` items (the review card can render up to
 * `MAX_VOICE_ANSWER_ROWS`, 24), raise `FETCH_LIMIT` deliberately rather
 * than reverting to an unbounded fetch.
 *
 * The bounded fetch means this skill genuinely CANNOT report an exact
 * total once the tenant has more than `MAX_ITEMS_SPOKEN + 1` pending items
 * — `data.count` is `null` in that case (never a false-precise guess), and
 * the summary says "5+ items" rather than inventing a total. A caller that
 * needs an exact total past that boundary needs a separate COUNT query —
 * deliberately NOT added here (that's a distinct, larger change than this
 * task's scope).
 *
 * ── "for tomorrow" is not a filter — and neededBy IS surfaced (spec-review
 * MAJOR B) ──
 *
 * Task 8's `MaterialItemListOptions` has only `jobId` and (as of I4)
 * `limit` — no `neededBy`/date filter — so a date-scoped ask like "what do
 * I need tomorrow?" cannot narrow the query; the classifier taxonomy
 * (intent-classifier.ts) no longer advertises that phrasing for this
 * reason. But `neededBy` IS captured by `add_material` and persisted on
 * every row (Task 9's own write leg) — silently never mentioning it on the
 * read side would mean this module collects data it then hides from the
 * very person who spoke it. So each spoken/rendered item states its
 * needed-by date when the row has one ("3 boxes of PEX, quantity 3, needed
 * by Aug 9") — the operator hears which of the (possibly unfiltered) items
 * are actually time-sensitive, rather than the system pretending to
 * understand "tomorrow" it cannot honor as a query filter. Adding a real
 * `neededBy` filter to `MaterialItemListOptions` (both backends) is a
 * genuine Task 8 contract extension, filed as separate follow-up work —
 * NOT done here.
 *
 * ── TTS-safe formatting (quality-review I2) ────────────────────────────────
 *
 * Per `spoken-format.ts`'s formatting contract: no symbols that read wrong
 * on TTS. The original `${quantity}× ${description}` shape used U+00D7
 * MULTIPLICATION SIGN, which Amazon Polly reads as "times" in a numeric
 * context ("3× 3 boxes" → "three times three boxes," i.e. nine) and Google
 * Cloud TTS typically drops entirely ("three three boxes"). Every quantity
 * is now spoken as the word "quantity" instead.
 */
import type { MaterialItem, MaterialItemRepository } from '../../materials/material-item';
import type { LookupEventService } from '../../lookup-events/lookup-event-service';
import { plural } from './spoken-format';

export interface LookupMaterialsInput {
  tenantId: string;
  sessionId?: string;
  /** Verified jobId, when a job was named and resolved (JOB_REF_INTENTS). */
  jobId?: string;
}

export interface LookupMaterialsDeps {
  materialItemRepo: MaterialItemRepository;
  lookupEvents?: LookupEventService;
}

export interface LookupMaterialsItem {
  description: string;
  quantity: number;
  vendor?: string;
  /** TTS-safe "MMM d" label for the item's `neededBy`, when it has one (see `formatNeededByLabel`). */
  neededByLabel?: string;
}

export type LookupMaterialsResult =
  | {
      status: 'found';
      summary: string;
      data: {
        /**
         * Exact pending count, or `null` once the tenant has more than
         * `MAX_ITEMS_SPOKEN + 1` pending items — this skill's bounded
         * fetch (I4) means the true total is genuinely unknown past that
         * point. Never a false-precise guess; see module doc comment.
         */
        count: number | null;
        /**
         * The (at most `MAX_ITEMS_SPOKEN`) OLDEST pending items actually
         * spoken/rendered (quality-review M2/M4) — named `spokenItems`,
         * not `items`, so a caller can never mistake this for the full
         * pending set. A caller asking "what's next after these?" hears
         * the newest-added items LAST, if at all — see module doc comment.
         */
        spokenItems: LookupMaterialsItem[];
      };
    }
  | { status: 'none'; summary: string; data: { count: 0; spokenItems: [] } }
  | { status: 'error'; summary: string; data: { error: string } };

const MAX_ITEMS_SPOKEN = 5;
// One extra row beyond what's ever spoken, fetched solely to detect "more
// exist" without a second COUNT query — see module doc comment (I4).
const FETCH_LIMIT = MAX_ITEMS_SPOKEN + 1;
/** Spoken-summary description cap — mirrors the row-builder's own label cap (`text()`, voice-lookup-answer.ts). */
const MAX_DESCRIPTION_CHARS = 80;

/**
 * Truncate a free-text description before it joins the spoken summary
 * sentence. Five ~1000-char descriptions concatenated would blow well past
 * `buildAnswer`'s 2000-char hard slice (voice-lookup-answer.ts), silently
 * truncating the sentence MID-WORD and dropping the "and more" tail
 * exactly when the list is longest (quality-review M1).
 */
function truncateForSpeech(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * "MMM d" label for a bare calendar date, anchored to UTC — NEVER
 * tz-shifted. Mirrors `create-service-agreement-task.ts`'s
 * `formatStartsOnLabel`: `neededBy` is persisted as a bare YYYY-MM-DD date
 * at midnight UTC (`add-material-handler.ts`), so rendering it in a
 * tenant timezone west of UTC could roll it back a calendar day.
 */
function formatNeededByLabel(d: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
  }).format(d);
}

/** One spoken clause per item — TTS-safe (I2), truncated (M1), needed-by surfaced when present (MAJOR B). */
function describeItem(m: LookupMaterialsItem): string {
  const parts = [`${truncateForSpeech(m.description, MAX_DESCRIPTION_CHARS)}, quantity ${m.quantity}`];
  if (m.vendor) parts.push(`from ${m.vendor}`);
  if (m.neededByLabel) parts.push(`needed by ${m.neededByLabel}`);
  return parts.join(', ');
}

export async function lookupMaterials(
  input: LookupMaterialsInput,
  deps: LookupMaterialsDeps,
): Promise<LookupMaterialsResult> {
  const start = Date.now();
  const record = async (
    resultStatus: 'found' | 'none' | 'error',
    resultCount: number,
    summary: string,
  ): Promise<void> => {
    if (!deps.lookupEvents) return;
    try {
      await deps.lookupEvents.record({
        tenantId: input.tenantId,
        sessionId: input.sessionId,
        intent: 'lookup_materials',
        resultStatus,
        resultCount,
        summary,
        latencyMs: Date.now() - start,
      });
    } catch {
      /* swallow — an audit-write failure never breaks the spoken turn */
    }
  };

  try {
    const items: MaterialItem[] = await deps.materialItemRepo.listPending(input.tenantId, {
      ...(input.jobId ? { jobId: input.jobId } : {}),
      limit: FETCH_LIMIT,
    });

    if (items.length === 0) {
      const summary = 'Your materials list is clear — nothing pending.';
      await record('none', 0, summary);
      return { status: 'none', summary, data: { count: 0, spokenItems: [] } };
    }

    const hasMore = items.length > MAX_ITEMS_SPOKEN;
    const spokenItems: LookupMaterialsItem[] = items.slice(0, MAX_ITEMS_SPOKEN).map((m) => ({
      description: m.description,
      quantity: m.quantity,
      ...(m.vendor ? { vendor: m.vendor } : {}),
      ...(m.neededBy ? { neededByLabel: formatNeededByLabel(m.neededBy) } : {}),
    }));

    const countPhrase = hasMore
      ? `${MAX_ITEMS_SPOKEN}+ ${plural(MAX_ITEMS_SPOKEN, 'item')}`
      : `${items.length} ${plural(items.length, 'item')}`;
    const summary =
      `${countPhrase} on the materials list: ` +
      spokenItems.map(describeItem).join('; ') +
      (hasMore ? '; and more beyond that' : '');

    // resultCount is the number of rows actually FETCHED (up to
    // FETCH_LIMIT) — a true, if capped, measurement; never the guessed
    // total `data.count` deliberately withholds once `hasMore` is true.
    await record('found', items.length, summary);
    return {
      status: 'found',
      summary,
      data: {
        count: hasMore ? null : items.length,
        spokenItems,
      },
    };
  } catch (err) {
    const summary = "I'm having trouble pulling up the materials list right now.";
    await record('error', 0, summary);
    return {
      status: 'error',
      summary,
      data: { error: err instanceof Error ? err.message : String(err) },
    };
  }
}
