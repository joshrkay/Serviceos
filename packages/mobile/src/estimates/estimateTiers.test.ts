import { describe, expect, it } from 'vitest';
import type { LineItem } from '../components/LineItemSheet';
import {
  buildTierLineItems,
  emptyTiers,
  filledTiers,
  TIER_GROUP_KEY,
  type TierDraft,
  type TierId,
} from './estimateTiers';

function line(description: string, unitPriceCents: number, quantity = 1): LineItem {
  return { catalogItemId: `cat-${description}`, description, quantity, unitPriceCents };
}

function tiersWith(items: Partial<Record<TierId, LineItem>>): TierDraft[] {
  return emptyTiers().map((t) => ({ ...t, item: items[t.id] ?? null }));
}

describe('emptyTiers / filledTiers', () => {
  it('starts as three empty Good/Better/Best slots', () => {
    const t = emptyTiers();
    expect(t.map((x) => x.id)).toEqual(['good', 'better', 'best']);
    expect(filledTiers(t)).toHaveLength(0);
  });

  it('reports only slots with an assigned catalog line, in order', () => {
    const t = tiersWith({ good: line('Basic', 10000), best: line('Premium', 30000) });
    expect(filledTiers(t).map((x) => x.id)).toEqual(['good', 'best']);
  });
});

describe('buildTierLineItems — multi-tier group', () => {
  it('builds a mutually-exclusive group with exactly one default', () => {
    const t = tiersWith({
      good: line('Basic roof', 500000),
      better: line('Standard roof', 800000),
      best: line('Premium roof', 1200000),
    });
    const out = buildTierLineItems(t, 'better');

    expect(out).toHaveLength(3);
    // Every tier shares the group key + label and is a selectable option.
    for (const li of out) {
      expect(li.groupKey).toBe(TIER_GROUP_KEY);
      expect(li.groupLabel).toBe('Options');
      expect(li.isOptional).toBe(true);
    }
    // Exactly one default, and it is the chosen "better" tier.
    const defaults = out.filter((li) => li.isDefaultSelected === true);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].description).toBe('Standard roof');
    // Order preserved (Good→Better→Best) and prices/qty untouched (integer cents).
    expect(out.map((li) => li.unitPriceCents)).toEqual([500000, 800000, 1200000]);
  });

  it('falls back to the first filled tier when the chosen default is empty', () => {
    const t = tiersWith({ good: line('Basic', 500000), best: line('Premium', 1200000) });
    // 'better' slot is empty → default falls back to the first filled ('good').
    const out = buildTierLineItems(t, 'better');
    const defaults = out.filter((li) => li.isDefaultSelected === true);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].description).toBe('Basic');
  });

  it('honours a custom group label, trimming blanks to the default', () => {
    const t = tiersWith({ good: line('A', 100), better: line('B', 200) });
    expect(buildTierLineItems(t, 'good', 'Roof replacement')[0].groupLabel).toBe('Roof replacement');
    expect(buildTierLineItems(t, 'good', '   ')[0].groupLabel).toBe('Options');
  });
});

describe('buildTierLineItems — single-tier / degenerate (no regression)', () => {
  it('emits a lone tier as a FLAT line with no grouping fields', () => {
    const t = tiersWith({ good: line('Just this', 25000) });
    const out = buildTierLineItems(t, 'good');
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      catalogItemId: 'cat-Just this',
      description: 'Just this',
      quantity: 1,
      unitPriceCents: 25000,
    });
    expect(out[0].groupKey).toBeUndefined();
    expect(out[0].isDefaultSelected).toBeUndefined();
  });

  it('strips stale grouping fields off a demoted singleton', () => {
    const stale: LineItem = {
      description: 'Was grouped',
      quantity: 1,
      unitPriceCents: 100,
      groupKey: 'tier',
      groupLabel: 'Options',
      isOptional: true,
      isDefaultSelected: true,
    };
    const out = buildTierLineItems(tiersWith({ good: stale }), 'good');
    expect(out[0].groupKey).toBeUndefined();
    expect(out[0].groupLabel).toBeUndefined();
    expect(out[0].isOptional).toBeUndefined();
    expect(out[0].isDefaultSelected).toBeUndefined();
  });

  it('returns an empty array when no tier is filled', () => {
    expect(buildTierLineItems(emptyTiers(), 'good')).toEqual([]);
  });
});
