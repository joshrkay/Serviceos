/**
 * P22-001 — Catalog-priced voice invoice line items.
 *
 * Pure resolution module: matches LLM-extracted ("spoken") line items
 * against the tenant's service catalog so resolved items always carry
 * the EXACT catalog `unitPriceCents` — never the LLM's guess.
 *
 * Design rules (see docs/superpowers/contracts/p22-dispatch-addendum.md):
 * - A spoken item resolves only when there is a single unambiguous
 *   catalog candidate. Ambiguity → `unresolved` (needsPricing), never a
 *   guess. Unresolved > wrongly-priced.
 * - Pure functions only — no I/O, no repo access. Mirrors the style of
 *   the orchestration resolvers so it is trivially unit-testable.
 * - All money is integer cents.
 */

/** A line item as extracted by the LLM from the transcript. */
export interface SpokenLineItem {
  description: string;
  quantity?: number;
}

/** A spoken item successfully matched to exactly one catalog item. */
export interface ResolvedLineItem {
  catalogItemId: string;
  /** Canonical catalog name (replaces the spoken phrasing). */
  description: string;
  quantity: number;
  /** EXACT catalog price — integer cents. */
  unitPriceCents: number;
  unit?: string;
  category?: string;
}

export interface CatalogResolutionResult {
  resolved: ResolvedLineItem[];
  unresolved: SpokenLineItem[];
}

/** Minimal catalog shape the resolver needs (subset of CatalogItem). */
export interface ResolvableCatalogItem {
  id: string;
  name: string;
  unitPriceCents: number;
  unit?: string;
  category?: string;
}

/** Max catalog items injected into an LLM prompt. Addendum risk note. */
export const CATALOG_PROMPT_ITEM_CAP = 150;

/**
 * Normalize free text for matching: lowercase, strip punctuation,
 * collapse whitespace, and naively singularize each token (trailing
 * "s") so "three gaskets" matches catalog item "Gasket".
 */
export function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => (token.length > 3 && token.endsWith('s') ? token.slice(0, -1) : token))
    .join(' ');
}

function candidatesFor(
  spokenNorm: string,
  catalog: Array<{ item: ResolvableCatalogItem; norm: string }>,
): ResolvableCatalogItem[] {
  if (!spokenNorm) return [];

  // Pass 1 — exact normalized equality beats everything.
  const exact = catalog.filter((c) => c.norm === spokenNorm);
  if (exact.length > 0) return exact.map((c) => c.item);

  // Pass 2 — ILIKE-style fuzzy containment, either direction:
  // spoken "water heater" matches catalog "Water Heater Install";
  // spoken "standard water heater install" matches catalog "Water Heater Install".
  return catalog
    .filter((c) => c.norm.includes(spokenNorm) || spokenNorm.includes(c.norm))
    .map((c) => c.item);
}

/**
 * Resolve spoken line items against the catalog.
 *
 * A spoken item resolves ONLY when exactly one catalog candidate
 * matches; zero or multiple candidates leave it `unresolved`. Resolved
 * items take the catalog's price/name verbatim. Quantity defaults to 1
 * when unstated or invalid.
 */
export function resolveSpokenLineItems(
  spokenItems: SpokenLineItem[],
  catalogItems: ResolvableCatalogItem[],
): CatalogResolutionResult {
  const resolved: ResolvedLineItem[] = [];
  const unresolved: SpokenLineItem[] = [];

  const normalizedCatalog = catalogItems.map((item) => ({
    item,
    norm: normalizeForMatch(item.name),
  }));

  for (const spoken of spokenItems) {
    const spokenNorm = normalizeForMatch(spoken.description ?? '');
    const candidates = candidatesFor(spokenNorm, normalizedCatalog);

    if (candidates.length === 1) {
      const match = candidates[0];
      const qty =
        typeof spoken.quantity === 'number' && Number.isFinite(spoken.quantity) && spoken.quantity > 0
          ? spoken.quantity
          : 1;
      resolved.push({
        catalogItemId: match.id,
        description: match.name,
        quantity: qty,
        unitPriceCents: match.unitPriceCents,
        ...(match.unit ? { unit: match.unit } : {}),
        ...(match.category ? { category: match.category } : {}),
      });
    } else {
      // 0 candidates (not in catalog) or >1 (ambiguous): never guess.
      unresolved.push(spoken);
    }
  }

  return { resolved, unresolved };
}

/**
 * Build the compact catalog table injected into the LLM prompt.
 * Capped at {@link CATALOG_PROMPT_ITEM_CAP} items (alphabetical — no
 * usage data is tracked yet); notes truncation in the prompt so the
 * model knows the list is incomplete.
 *
 * Returns an empty string for an empty catalog so callers can degrade
 * to the existing free-text behavior with zero prompt change.
 */
export function buildCatalogPromptSection(catalogItems: ResolvableCatalogItem[]): string {
  if (catalogItems.length === 0) return '';

  const sorted = [...catalogItems].sort((a, b) => a.name.localeCompare(b.name));
  const shown = sorted.slice(0, CATALOG_PROMPT_ITEM_CAP);
  const truncated = sorted.length > CATALOG_PROMPT_ITEM_CAP;

  const lines = shown.map(
    (i) => `- ${i.name} | ${i.unit ?? 'each'} | ${i.unitPriceCents} cents`,
  );

  return [
    'Service catalog (name | unit | price in integer cents). When a spoken item matches a catalog entry, use the catalog name and price exactly:',
    ...lines,
    ...(truncated
      ? [
          `(catalog truncated — showing ${CATALOG_PROMPT_ITEM_CAP} of ${sorted.length} items; other items exist)`,
        ]
      : []),
  ].join('\n');
}
