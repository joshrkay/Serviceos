import { createPlumbingPack, PLUMBING_LINE_ITEM_DEFAULTS } from '../../src/verticals/packs/plumbing';
import { resolveTerminology, getChildCategories } from '../../src/verticals/registry';

describe('P4-003 — Plumbing Vertical Pack', () => {
  const pack = createPlumbingPack();

  it('creates pack with correct type and name', () => {
    expect(pack.type).toBe('plumbing');
    expect(pack.name).toBe('Plumbing Professional');
    expect(pack.version).toBe('1.0.0');
  });

  it('has top-level categories', () => {
    const topLevel = getChildCategories(pack, undefined);
    expect(topLevel.length).toBeGreaterThanOrEqual(4);
    const names = topLevel.map((c) => c.name);
    expect(names).toContain('Installation');
    expect(names).toContain('Repair');
    expect(names).toContain('Maintenance');
  });

  it('has repair subcategories', () => {
    const children = getChildCategories(pack, 'plumb-repair');
    expect(children.length).toBeGreaterThanOrEqual(5);
    const names = children.map((c) => c.name);
    expect(names).toContain('Leak Repair');
    expect(names).toContain('Drain Clearing');
  });

  it('resolves plumbing-specific terminology', () => {
    expect(resolveTerminology(pack, 'tankless')?.displayName).toBe('Tankless Water Heater');
    expect(resolveTerminology(pack, 'disposal')?.displayName).toBe('Garbage Disposal');
    expect(resolveTerminology(pack, 'hydro jet')?.displayName).toBe('Hydro Jetting');
    expect(resolveTerminology(pack, 'auger')?.displayName).toBe('Drain Snake');
  });

  it('has line item defaults in integer cents', () => {
    expect(Number.isInteger(PLUMBING_LINE_ITEM_DEFAULTS.laborRatePerHourCents)).toBe(true);
    expect(PLUMBING_LINE_ITEM_DEFAULTS.drainCleaningCents).toBeGreaterThan(0);
  });
});
