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
 *     authoritative; the LLM's number is overwritten.
 *   - 'ambiguous'       → two-plus plausible items (or one weak match).
 *     The LLM price is kept but the proposal is forced to 'draft' via
 *     missingFields so the operator picks the right item — an uncertain
 *     match must never silently set a price.
 *   - 'none'            → not in the catalog. The LLM price is kept but
 *     flagged `uncatalogued` and the proposal confidence is capped below
 *     the auto-approve threshold, so a human always reviews it.
 *
 * Pure and deterministic — no I/O, no LLM. Operates on a preloaded
 * tenant catalog array (1-5 person shops have small catalogs; one
 * listByTenant per draft is negligible next to the LLM round trip, and
 * a pure function is trivially unit-testable with no migration).
 */
import type { CatalogItem } from '../../catalog/catalog-item';

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
    Array<{ id: string; name: string; unitPriceCents: number; score: number }>
  >;
  anyUncatalogued: boolean;
  anyCatalogPriced: boolean;
}

/** Catalog categories → the proposal contract's line-item vocabulary. */
function contractCategory(item: CatalogItem): string {
  return item.category === 'Labor' ? 'labor' : 'material';
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
      const next: Record<string, unknown> = {
        ...li,
        [priceField]: item.unitPriceCents,
        catalogItemId: item.id,
        pricingSource: 'catalog' satisfies PricingSource,
        category: contractCategory(item),
      };
      if ('totalCents' in li) {
        const qty = Number(li.quantity ?? 1) || 1;
        next.totalCents = Math.round(item.unitPriceCents * qty);
      }
      out.push(next);
      anyCatalogPriced = true;
      return;
    }
    if (resolution.tier === 'ambiguous' && resolution.candidates) {
      out.push({ ...li, pricingSource: 'ambiguous' satisfies PricingSource });
      missingFields.push(`lineItems[${idx}].catalogItemId`);
      catalogResolution[idx] = resolution.candidates.map((c) => ({
        id: c.item.id,
        name: c.item.name,
        unitPriceCents: c.item.unitPriceCents,
        score: c.score,
      }));
      return;
    }
    out.push({ ...li, pricingSource: 'uncatalogued' satisfies PricingSource });
    anyUncatalogued = true;
  });

  return {
    lineItems: out,
    missingFields,
    ...(missingFields.length > 0 ? { catalogResolution } : {}),
    anyUncatalogued,
    anyCatalogPriced,
  };
}
