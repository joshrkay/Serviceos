/**
 * Catalog resolver — grounds AI-drafted line items in the tenant's
 * actual price book.
 *
 * The draft_invoice / draft_estimate task handlers ask the LLM to emit
 * line items, and the LLM happily invents `unitPrice` figures. Money
 * must come from the tenant's catalog, not from a language model, so
 * after the LLM turn each line-item description is resolved here
 * against the tenant's active catalog items:
 *
 *   - 'exact' / 'high'  → the catalog item's `unitPriceCents` is
 *     authoritative and the LLM's number is overwritten — UNLESS the
 *     drafted line carries its own positive integer price that deviates
 *     from the catalog price by more than BOTH `PRICE_CONFLICT_MIN_REL`
 *     and `PRICE_CONFLICT_MIN_ABS_CENTS` (see `applyCatalogPricing`). A
 *     deviation that large is a "did you mean" price CONFLICT, not a
 *     mishear — the owner may have deliberately quoted a custom or
 *     discounted price ("do it for Mrs. Henderson at half price"). That
 *     case is surfaced exactly like an 'ambiguous' match instead of being
 *     silently snapped: the drafted price is kept, `pricingSource:
 *     'ambiguous'`, and two candidates are recorded — the real catalog
 *     item and a synthetic "keep spoken price" choice — for the operator
 *     to pick via the same one-tap resolution as any other ambiguity.
 *   - 'ambiguous'       → two-plus plausible items (or one weak match).
 *     The LLM price is kept but the proposal is forced to 'draft' via
 *     missingFields so the operator picks the right item — an uncertain
 *     match must never silently set a price.
 *   - 'none'            → not in the catalog. The LLM price is kept but
 *     flagged `uncatalogued`, `requiresReview` is forced true, and the
 *     proposal confidence is capped below the auto-approve threshold — the
 *     cap is defense in depth, `requiresReview` is the hard, threshold-
 *     independent gate (a tenant can override the numeric threshold; it
 *     cannot override this). Consumers thread `requiresReview` into
 *     `payload._meta.overallConfidence = 'low'`, which `decideInitialStatus`
 *     (proposals/proposal.ts) blocks on via `confidenceMetaBlocksAutoApprove`
 *     BEFORE resolving any tenant threshold override — so a human always
 *     reviews an AI-invented price, no matter how the auto-approve threshold
 *     is configured.
 *
 * Pure and deterministic — no I/O, no LLM. Operates on a preloaded
 * tenant catalog array (1-5 person shops have small catalogs; one
 * listByTenant per draft is negligible next to the LLM round trip, and
 * a pure function is trivially unit-testable with no migration).
 */
import type { CatalogItem } from '../../catalog/catalog-item';
import type { ConfidenceLevel } from '../guardrails/confidence';

export type CatalogMatchTier = 'exact' | 'high' | 'ambiguous' | 'none';
export type CatalogMatchType = 'exact' | 'prefix' | 'token_overlap' | 'fuzzy';

export interface CatalogCandidate {
  item: CatalogItem;
  /** Match score in [0,1]; higher is closer. */
  score: number;
  matchType: CatalogMatchType;
}

export interface CatalogLineResolution {
  /** The raw line-item description that was resolved. */
  query: string;
  tier: CatalogMatchTier;
  /** Set for 'exact' | 'high'. */
  match?: CatalogItem;
  /** Set for 'ambiguous' — top candidates, score desc, max 3. */
  candidates?: CatalogCandidate[];
}

/** Best score ≥ this (with MARGIN lead) resolves without clarification. */
export const TAU_HIGH = 0.85;
/** Required lead over the runner-up before a best match wins outright. */
export const MARGIN = 0.15;
/** Scores below this are not candidates at all. */
export const TAU_FLOOR = 0.6;
/**
 * Minimum relative deviation (as a fraction of the catalog price) between
 * a drafted line's own price and its exact/high catalog match before it's
 * treated as a "did you mean" price conflict rather than a mishear.
 */
export const PRICE_CONFLICT_MIN_REL = 0.1;
/**
 * Minimum absolute deviation (integer cents) between a drafted line's own
 * price and its exact/high catalog match before it's treated as a "did
 * you mean" price conflict. Paired with `PRICE_CONFLICT_MIN_REL` — BOTH
 * must be exceeded (a few cents of rounding noise on a $2,000 job is a
 * huge relative miss but zero real-money risk; a $200 miss on a $5 line
 * is a huge relative miss AND real money).
 */
export const PRICE_CONFLICT_MIN_ABS_CENTS = 100;
/** Description matches are weaker evidence than name matches. */
export const DESCRIPTION_WEIGHT = 0.6;
/** Max candidates surfaced on an ambiguous result. */
const MAX_CANDIDATES = 3;
/**
 * Confidence ceiling for drafts containing an uncatalogued (LLM-priced)
 * line. Deliberately below the 0.9 autonomous auto-approve threshold so
 * an AI-invented price always lands in front of a human.
 */
export const UNCATALOGUED_CONFIDENCE_CAP = 0.85;

// Filler words that carry no matching signal in spoken line items
// ("two hours of labor", "a new filter for the unit").
const STOPWORDS = new Set(['a', 'an', 'the', 'of', 'for', 'per', 'and', 'with']);

// Tokens that end in 's' but are singular trade/common terms — naive
// 's'-stripping would corrupt them ("gas" → "ga"). Endings-based rules
// below catch most ('ss', 'us', 'is'); this set pins the known traps
// explicitly so a rule tweak can't silently regress them.
const NO_SINGULARIZE = new Set(['gas', 'lens', 'plus', 'hvac']);

/**
 * Singularize one normalized token with trade-aware exceptions.
 * Symmetric: applied to both query and catalog tokens so "fittings"
 * matches "fitting" regardless of which side is plural.
 */
export function singularizeToken(token: string): string {
  if (token.length < 4) return token; // protects 'gas', 'bus', and all short tokens
  if (NO_SINGULARIZE.has(token)) return token;
  if (token.endsWith('ss') || token.endsWith('us') || token.endsWith('is')) return token;
  if (token.endsWith('ies')) return `${token.slice(0, -3)}y`; // assemblies → assembly
  if (token.endsWith('sses')) return token.slice(0, -2); // glasses → glass
  if (/(?:s|x|z|ch|sh)es$/.test(token)) return token.slice(0, -2); // switches → switch, boxes → box
  if (token.endsWith('s')) return token.slice(0, -1); // fittings → fitting
  return token;
}

/**
 * Normalize free text to comparable tokens: trim, accent-fold (NFKD +
 * strip combining marks), lowercase, punctuation → spaces, drop
 * stopwords and sub-2-char tokens, singularize.
 */
export function normalizeForMatch(raw: string): string[] {
  const folded = raw
    .trim()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // strip combining diacritics (accent fold)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  if (folded.length === 0) return [];
  return (
    folded
      .split(/\s+/)
      // Digit-only tokens are quantities ("2 hours labor"), not item
      // identity — quantity already rides the line item's own field.
      .filter((t) => t.length >= 2 && !STOPWORDS.has(t) && !/^\d+$/.test(t))
      .map(singularizeToken)
  );
}

/**
 * Bounded Levenshtein distance with early exit: returns Infinity as
 * soon as the distance must exceed `max`. Small inputs (single spoken
 * tokens), so the O(len²) matrix is fine; the bound keeps worst cases
 * cheap.
 */
function levenshtein(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return Infinity;
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > max) return Infinity;
    prev = curr;
  }
  return prev[b.length];
}

/** Max edit distance allowed for a fuzzy token hit, by token length. */
function fuzzyBudget(token: string): number {
  if (token.length >= 7) return 2; // "condensor" → "condenser"
  if (token.length >= 4) return 1; // "heeter" → "heater"
  return 0; // short tokens must match exactly
}

const FUZZY_HIT_WEIGHT = 0.8;
/**
 * Spoken queries are usually SHORTER than catalog names ("water heater"
 * → "Water Heater Install"), so unmatched catalog-name tokens dilute
 * the score gently rather than symmetrically (Jaccard would sink the
 * realistic case to ~0.56). Unmatched QUERY tokens still dilute at
 * full weight — extra spoken words the catalog doesn't have are real
 * mismatch evidence.
 */
const UNMATCHED_TARGET_PENALTY = 0.3;

interface TokenScore {
  score: number;
  usedFuzzy: boolean;
}

/**
 * Coverage-based token overlap where a near-miss (within the
 * Levenshtein budget) counts as a partial hit. Catches transcription
 * noise from noisy trucks and accents without a dependency.
 *
 *   score = hits / (|query| + 0.3 × unmatched target tokens)
 */
function tokenOverlapScore(queryTokens: string[], targetTokens: string[]): TokenScore {
  if (queryTokens.length === 0 || targetTokens.length === 0) {
    return { score: 0, usedFuzzy: false };
  }
  const remaining = [...targetTokens];
  let hits = 0;
  let usedFuzzy = false;
  for (const q of queryTokens) {
    const exactIdx = remaining.indexOf(q);
    if (exactIdx !== -1) {
      remaining.splice(exactIdx, 1);
      hits += 1;
      continue;
    }
    const budget = fuzzyBudget(q);
    if (budget === 0) continue;
    const fuzzyIdx = remaining.findIndex((t) => levenshtein(q, t, budget) <= budget);
    if (fuzzyIdx !== -1) {
      remaining.splice(fuzzyIdx, 1);
      hits += FUZZY_HIT_WEIGHT;
      usedFuzzy = true;
    }
  }
  if (hits === 0) return { score: 0, usedFuzzy: false };
  const denom = queryTokens.length + UNMATCHED_TARGET_PENALTY * remaining.length;
  return { score: hits / denom, usedFuzzy };
}

function multisetEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((t, i) => t === sortedB[i]);
}

function isPrefix(queryTokens: string[], targetTokens: string[]): boolean {
  if (queryTokens.length === 0 || queryTokens.length > targetTokens.length) return false;
  return queryTokens.every((t, i) => t === targetTokens[i]);
}

function scoreAgainstTokens(
  queryTokens: string[],
  targetTokens: string[],
): { score: number; matchType: CatalogMatchType } | null {
  if (targetTokens.length === 0) return null;
  if (queryTokens.join(' ') === targetTokens.join(' ')) {
    return { score: 1.0, matchType: 'exact' };
  }
  if (isPrefix(queryTokens, targetTokens) || multisetEqual(queryTokens, targetTokens)) {
    return { score: 0.92, matchType: 'prefix' };
  }
  const overlap = tokenOverlapScore(queryTokens, targetTokens);
  if (overlap.score <= 0) return null;
  return { score: overlap.score, matchType: overlap.usedFuzzy ? 'fuzzy' : 'token_overlap' };
}

/**
 * Score one catalog item against query tokens. Name is primary
 * evidence; description is secondary (× DESCRIPTION_WEIGHT). Returns
 * null below TAU_FLOOR.
 */
export function scoreCandidate(queryTokens: string[], item: CatalogItem): CatalogCandidate | null {
  const nameResult = scoreAgainstTokens(queryTokens, normalizeForMatch(item.name)) as
    | { score: number; matchType: CatalogMatchType }
    | null;
  const descTokens = item.description ? normalizeForMatch(item.description) : [];
  const descRaw = scoreAgainstTokens(queryTokens, descTokens) as
    | { score: number; matchType: CatalogMatchType }
    | null;
  // Description evidence is secondary in BOTH dimensions: score is
  // discounted, and matchType is capped at 'token_overlap' so a
  // description-only "exact" can never be promoted to the exact tier
  // (which would silently set a price off weaker evidence).
  const descResult = descRaw
    ? {
        score: descRaw.score * DESCRIPTION_WEIGHT,
        matchType: (descRaw.matchType === 'fuzzy' ? 'fuzzy' : 'token_overlap') as CatalogMatchType,
      }
    : null;

  const best =
    nameResult && (!descResult || nameResult.score >= descResult.score) ? nameResult : descResult;
  if (!best || best.score < TAU_FLOOR) return null;
  return { item, score: best.score, matchType: best.matchType };
}

const MATCH_TYPE_RANK: Record<CatalogMatchType, number> = {
  exact: 0,
  prefix: 1,
  token_overlap: 2,
  fuzzy: 3,
};

/**
 * Resolve one spoken/LLM line-item description against the tenant's
 * ACTIVE catalog items (caller pre-filters archived). See module doc
 * for tier semantics.
 */
export function resolveLineItemToCatalog(
  query: string,
  activeItems: CatalogItem[],
): CatalogLineResolution {
  const queryTokens = normalizeForMatch(query);
  // Degenerate guard: nothing matchable ("", "x", emoji-only) must
  // never fuzzy-match a price.
  if (queryTokens.length === 0 || queryTokens.every((t) => t.length < 3)) {
    return { query, tier: 'none' };
  }

  const candidates = activeItems
    .map((item) => scoreCandidate(queryTokens, item))
    .filter((c): c is CatalogCandidate => c !== null)
    .sort(
      (a, b) =>
        MATCH_TYPE_RANK[a.matchType] - MATCH_TYPE_RANK[b.matchType] ||
        b.score - a.score ||
        a.item.name.localeCompare(b.item.name),
    );

  if (candidates.length === 0) return { query, tier: 'none' };

  const best = candidates[0];
  const contenders = candidates.filter((c) => best.score - c.score < MARGIN);

  if (contenders.length > 1) {
    // Tie. Identical price across every contender means the money
    // outcome is identical — pick deterministically (alphabetical) and
    // treat as resolved. A price-differing tie is NEVER broken silently.
    const allSamePrice = contenders.every(
      (c) => c.item.unitPriceCents === best.item.unitPriceCents,
    );
    if (!allSamePrice) {
      return { query, tier: 'ambiguous', candidates: contenders.slice(0, MAX_CANDIDATES) };
    }
    const winner = [...contenders].sort((a, b) => a.item.name.localeCompare(b.item.name))[0];
    return { query, tier: best.matchType === 'exact' ? 'exact' : 'high', match: winner.item };
  }

  if (best.matchType === 'exact') return { query, tier: 'exact', match: best.item };
  if (best.score >= TAU_HIGH) return { query, tier: 'high', match: best.item };
  // Unambiguous but weak (floor ≤ score < TAU_HIGH): surface as a
  // single-candidate ambiguity — a 0.7 match must not silently set a price.
  return { query, tier: 'ambiguous', candidates: [best] };
}

export function resolveLineItems(
  queries: string[],
  activeItems: CatalogItem[],
): CatalogLineResolution[] {
  return queries.map((q) => resolveLineItemToCatalog(q, activeItems));
}

/**
 * Pricing source stamped on each line item so the review UI (and the
 * audit trail) can show WHERE a price came from:
 *   catalog      — resolved; price is the catalog's, authoritative
 *   ambiguous    — candidates surfaced; operator must pick (missingFields)
 *   uncatalogued — no catalog match; LLM price kept, confidence capped
 *   manual       — operator-entered (not set by this module)
 */
export type PricingSource = 'catalog' | 'ambiguous' | 'uncatalogued' | 'manual';

export interface CatalogPricingOutcome {
  /** Line items with catalogItemId / pricingSource / price overrides applied. */
  lineItems: Array<Record<string, unknown>>;
  /** 'lineItems[i].catalogItemId' per ambiguous line — forces 'draft'. */
  missingFields: string[];
  /** Ambiguous-line candidates keyed by line index, for the review UI. */
  catalogResolution?: Record<
    number,
    Array<{
      id: string;
      name: string;
      unitPriceCents: number;
      score: number;
      /**
       * Contract category ('labor' | 'material') of the catalog item this
       * candidate represents. Absent on the synthetic `spoken:` "keep
       * spoken price" candidate — it has no catalog identity, so picking
       * it must leave the line's own category untouched (resolve-line.ts).
       */
      category?: string;
    }>
  >;
  anyUncatalogued: boolean;
  anyCatalogPriced: boolean;
  /**
   * Structural, threshold-independent hard gate: true whenever ANY line in
   * this outcome carries an AI-invented (uncatalogued) or operator-unpicked
   * (ambiguous) price. `true` here means "this outcome must never
   * auto-approve" — full stop, regardless of confidence score or any tenant
   * `auto_approve_threshold` override.
   *
   * Deliberately NOT folded into `missingFields`: `missingFields` is cleared
   * only via `resolveProposalLine` (proposals/resolve-line.ts), which
   * requires a recorded candidate set (only 'ambiguous' lines get one) — an
   * uncatalogued line has no candidates to pick from, so putting it in
   * `missingFields` would permanently deadlock approval instead of merely
   * blocking auto-approval. `requiresReview` is the numeric-cap's structural
   * companion, not a replacement for `missingFields`: it is `true` whenever
   * `anyUncatalogued` or `missingFields.length > 0`.
   *
   * NOTE for consumers: use this for STATUS gates (force 'draft' /
   * groundedClean checks). Do NOT drive the persisted
   * `payload._meta.overallConfidence = 'low'` stamp from it — that stamp is
   * never lifted by line resolution, so stamping ambiguous-only outcomes
   * 'low' would keep blocking chain-set/SMS approval after the operator
   * resolves the ambiguity. Drive the stamp from `anyUncatalogued` (an
   * uncatalogued line has nothing to resolve, so its block is rightly
   * permanent); ambiguity is gated by `missingFields`, which resolution
   * clears.
   */
  requiresReview: boolean;
}

/** Catalog categories → the proposal contract's line-item vocabulary. */
function contractCategory(item: CatalogItem): string {
  return item.category === 'Labor' ? 'labor' : 'material';
}

/**
 * True when a drafted line's own price and its exact/high catalog match
 * disagree enough to be a "did you mean" conflict rather than noise.
 * Requires BOTH the absolute (integer cents) and relative (fraction of
 * the catalog price) thresholds to be exceeded — the absolute check is
 * plain integer comparison; the ratio is computed with division (the
 * clearly-safe use of float per the money-safety invariant: only ever
 * compared against a fixed threshold, never itself stored or summed as
 * money).
 */
function isPriceConflict(draftedCents: number, catalogCents: number): boolean {
  const diffCents = Math.abs(draftedCents - catalogCents);
  if (diffCents < PRICE_CONFLICT_MIN_ABS_CENTS) return false;
  if (catalogCents <= 0) return true; // abs threshold alone already cleared
  return diffCents / catalogCents >= PRICE_CONFLICT_MIN_REL;
}

/**
 * Merge resolutions into LLM-drafted line items. Shared by the invoice
 * handler (priceField 'unitPriceCents', recomputes totalCents) and the
 * estimate handler (priceField 'unitPrice' — that contract's integer-
 * cents field). Pure: returns new line-item objects.
 */
export function applyCatalogPricing(
  lineItems: Array<Record<string, unknown>>,
  resolutions: CatalogLineResolution[],
  priceField: 'unitPriceCents' | 'unitPrice',
): CatalogPricingOutcome {
  const out: Array<Record<string, unknown>> = [];
  const missingFields: string[] = [];
  const catalogResolution: CatalogPricingOutcome['catalogResolution'] = {};
  let anyUncatalogued = false;
  let anyCatalogPriced = false;

  lineItems.forEach((li, idx) => {
    const resolution = resolutions[idx];
    if (!resolution) {
      out.push(li);
      return;
    }
    if ((resolution.tier === 'exact' || resolution.tier === 'high') && resolution.match) {
      const item = resolution.match;
      const draftedRaw = li[priceField];
      // Zero is a REAL drafted price (a comped/free line — the contract's
      // unitPriceCents is min(0)), so it must be conflict-eligible rather
      // than silently snapped back to the full catalog price.
      const draftedPrice =
        typeof draftedRaw === 'number' && Number.isInteger(draftedRaw) && draftedRaw >= 0
          ? draftedRaw
          : null;

      if (draftedPrice !== null && isPriceConflict(draftedPrice, item.unitPriceCents)) {
        // "Did you mean" — don't overwrite. Keep the drafted line exactly
        // as spoken and surface the conflict as a one-tap ambiguity: the
        // real catalog item vs. a synthetic "keep the spoken price"
        // choice. Nothing is priced yet, so `anyCatalogPriced` stays
        // false for this line.
        out.push({
          ...li,
          pricingSource: 'ambiguous' satisfies PricingSource,
          needsPricing: true,
        });
        missingFields.push(`lineItems[${idx}].catalogItemId`);
        catalogResolution[idx] = [
          {
            id: item.id,
            name: item.name,
            unitPriceCents: item.unitPriceCents,
            score: 1,
            category: contractCategory(item),
          },
          // Synthetic "keep spoken price" choice has no catalog identity —
          // no category is stamped, so picking it leaves the line's own
          // category untouched (see resolve-line.ts).
          { id: `spoken:${idx}`, name: 'Keep spoken price', unitPriceCents: draftedPrice, score: 0 },
        ];
        return;
      }

      const next: Record<string, unknown> = {
        ...li,
        description: item.name,
        [priceField]: item.unitPriceCents,
        catalogItemId: item.id,
        pricingSource: 'catalog' satisfies PricingSource,
        needsPricing: false,
        category: contractCategory(item),
      };
      if (priceField === 'unitPriceCents') {
        // Invoice contract carries totalCents per line; recompute it from
        // the authoritative price (also prices lines the LLM left
        // price-less, which the handler would otherwise drop).
        const qty = Number(li.quantity ?? 1) || 1;
        next.totalCents = Math.round(item.unitPriceCents * qty);
      }
      out.push(next);
      anyCatalogPriced = true;
      return;
    }
    if (resolution.tier === 'ambiguous' && resolution.candidates) {
      out.push({
        ...li,
        pricingSource: 'ambiguous' satisfies PricingSource,
        needsPricing: true,
      });
      missingFields.push(`lineItems[${idx}].catalogItemId`);
      catalogResolution[idx] = resolution.candidates.map((c) => ({
        id: c.item.id,
        name: c.item.name,
        unitPriceCents: c.item.unitPriceCents,
        score: c.score,
        category: contractCategory(c.item),
      }));
      return;
    }
    out.push({
      ...li,
      pricingSource: 'uncatalogued' satisfies PricingSource,
      needsPricing: true,
    });
    anyUncatalogued = true;
  });

  return {
    lineItems: out,
    missingFields,
    ...(missingFields.length > 0 ? { catalogResolution } : {}),
    anyUncatalogued,
    anyCatalogPriced,
    // Structural hard gate — see CatalogPricingOutcome doc. Ambiguous lines
    // already force 'draft' via missingFields; uncatalogued lines have no
    // missingFields entry (nothing to resolve to), so requiresReview is the
    // signal that blocks their auto-approval instead.
    requiresReview: anyUncatalogued || missingFields.length > 0,
  };
}

/**
 * Stamp every priced line as `uncatalogued` — used when there is no catalog
 * to ground against at all (repo unwired, empty catalog, or a read error). An
 * LLM-invented price that was NEVER checked against a catalog is exactly as
 * uncertain as an explicit 'none' match, so it must flip `anyUncatalogued`
 * (→ confidence cap) and stamp `pricingSource` (→ `_meta` low-confidence
 * markers). A line with no numeric price carries no money risk and is left
 * untouched (the handler drops it downstream).
 */
function markAllUncatalogued(
  lineItems: Array<Record<string, unknown>>,
  priceField: 'unitPriceCents' | 'unitPrice',
): CatalogPricingOutcome {
  let anyUncatalogued = false;
  const out = lineItems.map((li) => {
    if (typeof li[priceField] === 'number') {
      anyUncatalogued = true;
      return { ...li, pricingSource: 'uncatalogued' satisfies PricingSource, needsPricing: true };
    }
    return li;
  });
  return {
    lineItems: out,
    missingFields: [],
    anyUncatalogued,
    anyCatalogPriced: false,
    requiresReview: anyUncatalogued,
  };
}

/**
 * Ground drafted line items against the tenant catalog, ALWAYS returning a
 * `CatalogPricingOutcome`. This is the single grounding entry point for the
 * invoice / estimate / MMS-estimate task handlers.
 *
 * The bug this closes: the handlers previously left the outcome `undefined`
 * whenever the catalog could not be consulted — repo unwired, a `listByTenant`
 * error, or (the common case) an EMPTY catalog on a brand-new tenant — and an
 * undefined outcome silently skipped the uncatalogued confidence cap, letting a
 * draft priced entirely by the LLM auto-approve at the autonomous tier. Here
 * every such case funnels through `markAllUncatalogued`, so an ungrounded price
 * always caps confidence and surfaces to a human, per the module contract.
 *
 * Pass `loadActiveCatalog = null` when no catalog repo is wired.
 */
export async function groundLineItemPricing(
  lineItems: Array<Record<string, unknown>>,
  priceField: 'unitPriceCents' | 'unitPrice',
  loadActiveCatalog: (() => Promise<CatalogItem[]>) | null,
): Promise<CatalogPricingOutcome> {
  if (lineItems.length === 0) {
    return {
      lineItems,
      missingFields: [],
      anyUncatalogued: false,
      anyCatalogPriced: false,
      requiresReview: false,
    };
  }
  if (!loadActiveCatalog) return markAllUncatalogued(lineItems, priceField);

  let activeItems: CatalogItem[] = [];
  try {
    // A catalog read failure must never block drafting — degrade to
    // treating every line as uncatalogued (capped, human-reviewed).
    activeItems = (await loadActiveCatalog()).filter((i) => i.archivedAt === null);
  } catch {
    return markAllUncatalogued(lineItems, priceField);
  }
  if (activeItems.length === 0) return markAllUncatalogued(lineItems, priceField);

  const resolutions = resolveLineItems(
    lineItems.map((li) => String(li.description ?? '')),
    activeItems,
  );
  return applyCatalogPricing(lineItems, resolutions, priceField);
}

/**
 * RV-007 (F-4) — translate per-line `pricingSource` outcomes into the
 * payload `_meta` per-field confidence signals. NOT a new confidence
 * computation: it only re-expresses what `applyCatalogPricing` already
 * decided ('uncatalogued' / 'ambiguous' lines are the low-certainty
 * ones). Call with the FINAL payload line items (after any drop/filter
 * pass) so the `lineItems[i]` paths index the stored payload, not an
 * intermediate array. Returns empty maps when no line carries a
 * low-certainty pricing source (e.g. catalog grounding not wired).
 */
export function lineItemConfidenceSignals(
  lineItems: Array<Record<string, unknown>>,
  priceField: 'unitPriceCents' | 'unitPrice',
): {
  fieldConfidence: Record<string, ConfidenceLevel>;
  markers: Array<{ path: string; reason: string }>;
} {
  const fieldConfidence: Record<string, ConfidenceLevel> = {};
  const markers: Array<{ path: string; reason: string }> = [];

  lineItems.forEach((li, idx) => {
    const path = `lineItems[${idx}].${priceField}`;
    if (li.pricingSource === 'uncatalogued') {
      fieldConfidence[path] = 'low';
      markers.push({
        path,
        reason: `"${String(li.description ?? '')}" is not in the tenant catalog — the price is AI-estimated and needs review`,
      });
    } else if (li.pricingSource === 'ambiguous') {
      fieldConfidence[path] = 'low';
      markers.push({
        path,
        reason: `"${String(li.description ?? '')}" matched multiple catalog items — pick the right one to set the price`,
      });
    }
  });

  return { fieldConfidence, markers };
}
