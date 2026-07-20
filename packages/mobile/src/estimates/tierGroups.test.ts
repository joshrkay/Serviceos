import { describe, expect, it } from 'vitest';
import { groupEstimateTiers } from './tierGroups';

describe('groupEstimateTiers', () => {
  it('partitions base lines, tier groups, and add-ons', () => {
    const grouped = groupEstimateTiers([
      { id: 'base', description: 'Service call', unitPriceCents: 9900, totalCents: 9900 },
      { id: 'good', description: 'Good: basic unit', groupKey: 'system', groupLabel: 'System', unitPriceCents: 500000, totalCents: 500000 },
      { id: 'better', description: 'Better: mid unit', groupKey: 'system', groupLabel: 'System', unitPriceCents: 700000, totalCents: 700000, isDefaultSelected: true },
      { id: 'best', description: 'Best: premium unit', groupKey: 'system', groupLabel: 'System', unitPriceCents: 950000, totalCents: 950000 },
      { id: 'addon', description: 'Surge protector', isOptional: true, unitPriceCents: 12000, totalCents: 12000 },
    ]);

    expect(grouped.hasTiers).toBe(true);
    expect(grouped.baseLines.map((l) => l.id)).toEqual(['base']);
    expect(grouped.addOns.map((l) => l.id)).toEqual(['addon']);
    expect(grouped.tierGroups).toHaveLength(1);
    expect(grouped.tierGroups[0].groupKey).toBe('system');
    expect(grouped.tierGroups[0].groupLabel).toBe('System');
    expect(grouped.tierGroups[0].options.map((o) => o.id)).toEqual(['good', 'better', 'best']);
  });

  it('marks the default-selected tier option', () => {
    const grouped = groupEstimateTiers([
      { id: 'good', groupKey: 'g', unitPriceCents: 100 },
      { id: 'better', groupKey: 'g', unitPriceCents: 200, isDefaultSelected: true },
    ]);
    const selected = grouped.tierGroups[0].options.filter((o) => o.isDefaultSelected);
    expect(selected.map((o) => o.id)).toEqual(['better']);
  });

  it('treats a grouped line as a tier option even when isOptional is set', () => {
    const grouped = groupEstimateTiers([
      { id: 'x', groupKey: 'g', isOptional: true, unitPriceCents: 100 },
    ]);
    expect(grouped.addOns).toHaveLength(0);
    expect(grouped.tierGroups[0].options.map((o) => o.id)).toEqual(['x']);
  });

  it('falls back to unitPriceCents * quantity as integer cents when totalCents is absent', () => {
    const grouped = groupEstimateTiers([
      { id: 'l', description: 'Labor', quantity: 3, unitPriceCents: 8555 },
    ]);
    // 8555 * 3 = 25665 cents exactly — no float drift.
    expect(grouped.baseLines[0].totalCents).toBe(25665);
  });

  it('preserves first-seen group order across interleaved lines', () => {
    const grouped = groupEstimateTiers([
      { id: 'a1', groupKey: 'a', unitPriceCents: 1 },
      { id: 'b1', groupKey: 'b', unitPriceCents: 1 },
      { id: 'a2', groupKey: 'a', unitPriceCents: 1 },
    ]);
    expect(grouped.tierGroups.map((g) => g.groupKey)).toEqual(['a', 'b']);
    expect(grouped.tierGroups[0].options.map((o) => o.id)).toEqual(['a1', 'a2']);
  });

  it('returns empty buckets for no line items', () => {
    const grouped = groupEstimateTiers(undefined);
    expect(grouped).toEqual({ baseLines: [], tierGroups: [], addOns: [], hasTiers: false });
  });
});
