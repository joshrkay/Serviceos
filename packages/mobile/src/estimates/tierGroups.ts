/**
 * Good-better-best tier grouping for the estimate review screen.
 *
 * The server carries tier structure ON each line item, not as a separate
 * document field (packages/shared/src/contracts/money.ts): items sharing a
 * non-null `groupKey` are mutually-exclusive tiers (the good/better/best set),
 * `groupLabel` names that set, `isDefaultSelected` marks the pre-selected
 * option (which drives the headline total), and `isOptional` (with no
 * `groupKey`) is a standalone add-on. This module reshapes a flat line-item
 * array into those three buckets for display.
 *
 * Pure — money stays integer cents (totals are the server's `totalCents`, or a
 * cents-integer fallback of `unitPriceCents * quantity`; never float math).
 */

export interface TierLineInput {
  id?: string;
  description?: string;
  quantity?: number;
  unitPriceCents?: number;
  totalCents?: number;
  groupKey?: string;
  groupLabel?: string;
  isOptional?: boolean;
  isDefaultSelected?: boolean;
}

export interface TierLine {
  id?: string;
  description: string;
  quantity: number;
  unitPriceCents: number;
  totalCents: number;
  isDefaultSelected: boolean;
}

export interface TierGroup {
  groupKey: string;
  groupLabel?: string;
  options: TierLine[];
}

export interface GroupedEstimate {
  /** Non-optional, ungrouped lines — the always-included base scope. */
  baseLines: TierLine[];
  /** Mutually-exclusive tier sets, in first-seen `groupKey` order. */
  tierGroups: TierGroup[];
  /** Optional, ungrouped add-on lines. */
  addOns: TierLine[];
  /** True when at least one `groupKey` set exists (drives the tier UI). */
  hasTiers: boolean;
}

function normalize(line: TierLineInput): TierLine {
  const quantity = typeof line.quantity === 'number' ? line.quantity : 1;
  const unitPriceCents = typeof line.unitPriceCents === 'number' ? line.unitPriceCents : 0;
  const totalCents =
    typeof line.totalCents === 'number'
      ? line.totalCents
      : Math.round(unitPriceCents * quantity);
  return {
    id: line.id,
    description: line.description ?? '',
    quantity,
    unitPriceCents,
    totalCents,
    isDefaultSelected: line.isDefaultSelected === true,
  };
}

/**
 * Partition estimate line items into base scope, tier sets, and add-ons.
 * `groupKey` takes precedence over `isOptional` (a grouped line is a tier
 * option, never an add-on). Input order is preserved within every bucket, and
 * tier groups appear in the order their `groupKey` is first seen.
 */
export function groupEstimateTiers(lineItems: TierLineInput[] | undefined | null): GroupedEstimate {
  const baseLines: TierLine[] = [];
  const addOns: TierLine[] = [];
  const tierGroups: TierGroup[] = [];
  const groupIndex = new Map<string, TierGroup>();

  for (const raw of lineItems ?? []) {
    const line = normalize(raw);
    const groupKey = raw.groupKey?.trim();
    if (groupKey) {
      let group = groupIndex.get(groupKey);
      if (!group) {
        group = { groupKey, groupLabel: raw.groupLabel, options: [] };
        groupIndex.set(groupKey, group);
        tierGroups.push(group);
      } else if (!group.groupLabel && raw.groupLabel) {
        group.groupLabel = raw.groupLabel;
      }
      group.options.push(line);
    } else if (raw.isOptional === true) {
      addOns.push(line);
    } else {
      baseLines.push(line);
    }
  }

  return { baseLines, tierGroups, addOns, hasTiers: tierGroups.length > 0 };
}
