import { describe, it, expect } from 'vitest';
import { normalizeTierStructure } from '../../../src/ai/resolution/tier-structure';

type Line = Record<string, unknown>;

/** Minimal drafted line (estimate shape: `unitPrice`, no sortOrder). */
function line(description: string, extra: Line = {}): Line {
  return { description, quantity: 1, unitPrice: 10000, ...extra };
}

describe('normalizeTierStructure', () => {
  it('leaves a flat draft untouched (same array reference)', () => {
    const items = [line('Diagnostic'), line('Labor', { quantity: 2 })];
    const out = normalizeTierStructure(items);
    expect(out).toBe(items); // true no-op — identical reference
  });

  it('keeps a two-option group with one flagged default and marks both selectable', () => {
    const items = [
      line('Builder heater', { groupKey: 'wh', groupLabel: 'Water heater', isDefaultSelected: true }),
      line('Premium heater', { groupKey: 'wh', groupLabel: 'Water heater' }),
    ];
    const out = normalizeTierStructure(items);
    expect(out.map((li) => li.isDefaultSelected)).toEqual([true, false]);
    expect(out.every((li) => li.isOptional === true)).toBe(true);
    expect(out.map((li) => li.groupKey)).toEqual(['wh', 'wh']);
  });

  it('defaults the first option (array order) when the model flags none', () => {
    const items = [
      line('Good', { groupKey: 'g' }),
      line('Better', { groupKey: 'g' }),
      line('Best', { groupKey: 'g' }),
    ];
    const out = normalizeTierStructure(items);
    expect(out.map((li) => li.isDefaultSelected)).toEqual([true, false, false]);
  });

  it('keeps exactly one default when the model flags several (first in order wins)', () => {
    const items = [
      line('Good', { groupKey: 'g' }),
      line('Better', { groupKey: 'g', isDefaultSelected: true }),
      line('Best', { groupKey: 'g', isDefaultSelected: true }),
    ];
    const out = normalizeTierStructure(items);
    expect(out.map((li) => li.isDefaultSelected)).toEqual([false, true, false]);
  });

  it('demotes a singleton "group" by clearing groupKey/groupLabel, preserving the line', () => {
    const items = [
      line('Only option', { groupKey: 'solo', groupLabel: 'Tier', isOptional: false }),
      line('Labor'),
    ];
    const out = normalizeTierStructure(items);
    expect(out).toHaveLength(2);
    expect(out[0].groupKey).toBeUndefined();
    expect(out[0].groupLabel).toBeUndefined();
    expect(out[0].isOptional).toBe(false);
    expect(out[0].isDefaultSelected).toBe(false);
    expect(out[0].description).toBe('Only option');
  });

  it('demotes a singleton "group" to always-billed even when the model marked it optional', () => {
    // A one-option "tier" is a required base offering, not an add-on — it must
    // stay billed, never silently drop from the default total.
    const items = [line('Base install', { groupKey: 'solo', isOptional: true, isDefaultSelected: true })];
    const out = normalizeTierStructure(items); // addOnsRequested defaults false
    expect(out[0].groupKey).toBeUndefined();
    expect(out[0].isOptional).toBe(false);
    expect(out[0].isDefaultSelected).toBe(false);
  });

  it('forces an add-on off by default unless add-ons were requested', () => {
    const items = [line('Membership', { isOptional: true, isDefaultSelected: true })];
    expect(normalizeTierStructure(items)[0].isDefaultSelected).toBe(false);
    expect(normalizeTierStructure(items, { addOnsRequested: true })[0].isDefaultSelected).toBe(true);
  });

  it('clears a stray isDefaultSelected on an always-billed line', () => {
    const items = [line('Labor', { isDefaultSelected: true }), line('Filter', { groupKey: 'g' }), line('Filter B', { groupKey: 'g' })];
    const out = normalizeTierStructure(items);
    expect(out[0].isOptional).toBe(false);
    expect(out[0].isDefaultSelected).toBe(false);
  });

  it('preserves array length, order, and non-flag fields per index (index alignment)', () => {
    const items = [
      line('Good', { groupKey: 'g', unitPrice: 50000, pricingSource: 'catalog' }),
      line('Add-on', { isOptional: true, unitPrice: 8000, quantity: 3 }),
      line('Best', { groupKey: 'g', unitPrice: 90000, pricingSource: 'uncatalogued' }),
    ];
    const out = normalizeTierStructure(items);
    expect(out).toHaveLength(3);
    expect(out.map((li) => li.description)).toEqual(['Good', 'Add-on', 'Best']);
    expect(out.map((li) => li.unitPrice)).toEqual([50000, 8000, 90000]);
    expect(out.map((li) => li.pricingSource)).toEqual(['catalog', undefined, 'uncatalogued']);
    expect(out[1].quantity).toBe(3);
  });

  it('normalizes two independent groups separately', () => {
    const items = [
      line('WH good', { groupKey: 'wh' }),
      line('Panel good', { groupKey: 'panel' }),
      line('WH best', { groupKey: 'wh' }),
      line('Panel best', { groupKey: 'panel' }),
    ];
    const out = normalizeTierStructure(items);
    // Each group's first-in-order becomes its default.
    expect(out.map((li) => li.isDefaultSelected)).toEqual([true, true, false, false]);
  });
});
