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

  it('§3D — ships default intake_questions for caller disambiguation', () => {
    expect(pack.intakeQuestions).toBeDefined();
    expect((pack.intakeQuestions ?? []).length).toBeGreaterThan(0);
    const triggers = (pack.intakeQuestions ?? []).map((q) => q.trigger);
    expect(triggers).toEqual(expect.arrayContaining(['plumbing']));
    expect((pack.metadata as Record<string, unknown>).intake_questions).toBeDefined();
  });

  it('§3E — ships default objection_scripts for the calling agent', () => {
    expect(pack.objectionScripts).toBeDefined();
    expect((pack.objectionScripts ?? []).length).toBeGreaterThan(0);
    const ids = (pack.objectionScripts ?? []).map((s) => s.id);
    // 'minor_issue' is plumbing-specific (slow drain / small leak) —
    // a useful smoke test that the pack ships its own copy rather
    // than reusing HVAC defaults.
    expect(ids).toEqual(expect.arrayContaining(['price', 'dispatch_fee', 'minor_issue']));
    expect((pack.metadata as Record<string, unknown>).objection_scripts).toBeDefined();
  });
});
