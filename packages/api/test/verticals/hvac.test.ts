import { createHvacPack, HVAC_LINE_ITEM_DEFAULTS } from '../../src/verticals/packs/hvac';
import { resolveTerminology, getChildCategories } from '../../src/verticals/registry';

describe('P4-002 — HVAC Vertical Pack', () => {
  const pack = createHvacPack();

  it('creates pack with correct type and name', () => {
    expect(pack.type).toBe('hvac');
    expect(pack.name).toBe('HVAC Professional');
    expect(pack.version).toBe('1.0.0');
    expect(pack.isActive).toBe(true);
  });

  it('has top-level categories', () => {
    const topLevel = getChildCategories(pack, undefined);
    expect(topLevel.length).toBeGreaterThanOrEqual(4);
    const names = topLevel.map((c) => c.name);
    expect(names).toContain('Installation');
    expect(names).toContain('Repair');
    expect(names).toContain('Maintenance');
  });

  it('has installation subcategories', () => {
    const children = getChildCategories(pack, 'hvac-install');
    expect(children.length).toBeGreaterThanOrEqual(4);
    const names = children.map((c) => c.name);
    expect(names).toContain('AC Installation');
    expect(names).toContain('Furnace Installation');
  });

  it('resolves HVAC-specific terminology', () => {
    expect(resolveTerminology(pack, 'freon')?.displayName).toBe('Refrigerant');
    expect(resolveTerminology(pack, 'a/c')?.displayName).toBe('Air Conditioner');
    expect(resolveTerminology(pack, 'ductless')?.displayName).toBe('Mini-Split System');
    expect(resolveTerminology(pack, 'outdoor unit')?.displayName).toBe('Condenser');
  });

  it('has line item defaults in integer cents', () => {
    expect(Number.isInteger(HVAC_LINE_ITEM_DEFAULTS.laborRatePerHourCents)).toBe(true);
    expect(Number.isInteger(HVAC_LINE_ITEM_DEFAULTS.diagnosticFeeCents)).toBe(true);
    expect(HVAC_LINE_ITEM_DEFAULTS.laborRatePerHourCents).toBeGreaterThan(0);
  });
});
