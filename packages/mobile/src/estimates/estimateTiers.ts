// Pure (RN-free) helpers for the good-better-best estimate composer (A5). Kept
// pure so the tier-assembly logic unit-tests without a renderer.
//
// Tier model (matches the shipped web/api contract, NOT separate estimates):
// each tier is a SINGLE catalog-grounded line item; the mutually-exclusive tiers
// share one `groupKey` and exactly one carries `isDefaultSelected`. The customer
// picks one tier (radio) at approval time. Grouped tier lines also carry
// `isOptional=true` — mirroring the server tier normalizer
// (packages/api/src/shared/billing-engine.ts `normalizeTierStructure`) and the
// customer approval page's `isSelectable = isOptional || groupKey`
// (packages/web/src/components/customer/EstimateApprovalPage.tsx).
import type { LineItem } from '../components/LineItemSheet';

/** Presentational tier slots the composer offers, in ascending value order. */
export const TIER_LABELS = ['Good', 'Better', 'Best'] as const;
export type TierId = 'good' | 'better' | 'best';

/** Stable groupKey shared by every tier in one estimate's option group. */
export const TIER_GROUP_KEY = 'tier';
/** Group heading shown to the operator/customer (web default is "Options"). */
export const DEFAULT_TIER_GROUP_LABEL = 'Options';

export interface TierDraft {
  id: TierId;
  label: (typeof TIER_LABELS)[number];
  /** The single catalog line chosen for this tier, or null if the slot is empty. */
  item: LineItem | null;
}

/** The three empty tier slots the composer starts from. */
export function emptyTiers(): TierDraft[] {
  return [
    { id: 'good', label: 'Good', item: null },
    { id: 'better', label: 'Better', item: null },
    { id: 'best', label: 'Best', item: null },
  ];
}

/** Tier slots that have a catalog line assigned, in Good→Better→Best order. */
export function filledTiers(tiers: TierDraft[]): TierDraft[] {
  return tiers.filter((t) => t.item !== null);
}

/**
 * Assemble the composer's tier slots into the flat `LineItem[]` the create/update
 * payload carries.
 *
 * - Fewer than 2 filled tiers is NOT a group (a singleton "group" is malformed
 *   and the server refine rejects it): the lone tier is emitted as a plain flat
 *   line with no grouping fields, so a half-built tier estimate still saves and
 *   an "only Good" estimate is indistinguishable from a normal single-line one.
 * - Two or more filled tiers become one mutually-exclusive group: shared
 *   `groupKey`/`groupLabel`, `isOptional=true`, and exactly one
 *   `isDefaultSelected` (the chosen tier when it's filled, else the first filled
 *   tier — deterministic, matching the server normalizer's lowest-sortOrder pick).
 */
export function buildTierLineItems(
  tiers: TierDraft[],
  defaultTierId: TierId,
  groupLabel: string = DEFAULT_TIER_GROUP_LABEL,
): LineItem[] {
  const filled = filledTiers(tiers);
  if (filled.length < 2) {
    // Strip any stale grouping fields — a single tier is a flat line.
    return filled.map((t) => {
      const { groupKey: _gk, groupLabel: _gl, isOptional: _io, isDefaultSelected: _ds, ...rest } =
        t.item as LineItem;
      return { ...rest };
    });
  }
  const label = groupLabel.trim() || DEFAULT_TIER_GROUP_LABEL;
  const defaultId = filled.some((t) => t.id === defaultTierId) ? defaultTierId : filled[0].id;
  return filled.map((t) => ({
    ...(t.item as LineItem),
    groupKey: TIER_GROUP_KEY,
    groupLabel: label,
    isOptional: true,
    isDefaultSelected: t.id === defaultId,
  }));
}
