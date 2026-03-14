import {
  detectMissingItems,
  HVAC_MISSING_ITEM_RULES,
  PLUMBING_MISSING_ITEM_RULES,
} from '../../src/verticals/missing-items';
import { buildLineItem } from '../../src/shared/billing-engine';

describe('P4-008 — Missing-Item Detection', () => {
  it('detects missing thermostat check for AC install', () => {
    const lineItems = [
      buildLineItem('1', 'AC Unit Installation', 1, 350000, 1, true, 'equipment'),
      buildLineItem('2', 'Installation Labor', 4, 12500, 2, true, 'labor'),
    ];

    const signals = detectMissingItems(lineItems, HVAC_MISSING_ITEM_RULES, 'hvac-install-ac');
    const thermostatSignal = signals.find((s) => s.suggestedDescription.includes('Thermostat'));
    expect(thermostatSignal).toBeTruthy();
    expect(thermostatSignal!.severity).toBe('warning');
  });

  it('does not flag when thermostat is present', () => {
    const lineItems = [
      buildLineItem('1', 'AC Unit Installation', 1, 350000, 1, true, 'equipment'),
      buildLineItem('2', 'Thermostat compatibility check', 1, 7500, 2, true, 'labor'),
      buildLineItem('3', 'Refrigerant charge', 1, 7500, 3, true, 'material'),
      buildLineItem('4', 'Installation Labor', 4, 12500, 4, true, 'labor'),
    ];

    const signals = detectMissingItems(lineItems, HVAC_MISSING_ITEM_RULES, 'hvac-install-ac');
    const thermostatSignal = signals.find((s) => s.suggestedDescription.includes('Thermostat'));
    expect(thermostatSignal).toBeUndefined();
  });

  it('detects missing labor category', () => {
    const lineItems = [
      buildLineItem('1', 'AC Compressor', 1, 85000, 1, true, 'material'),
    ];

    const signals = detectMissingItems(lineItems, HVAC_MISSING_ITEM_RULES, 'hvac-repair-ac');
    const laborSignal = signals.find((s) => s.suggestedDescription === 'Labor');
    expect(laborSignal).toBeTruthy();
    expect(laborSignal!.severity).toBe('info');
  });

  it('does not flag labor when present', () => {
    const lineItems = [
      buildLineItem('1', 'Repair Labor', 2, 12500, 1, true, 'labor'),
      buildLineItem('2', 'Capacitor', 1, 3500, 2, true, 'material'),
    ];

    const signals = detectMissingItems(lineItems, HVAC_MISSING_ITEM_RULES, 'hvac-repair-ac');
    const laborSignal = signals.find((s) => s.suggestedDescription === 'Labor');
    expect(laborSignal).toBeUndefined();
  });

  it('detects missing permit for plumbing water heater install', () => {
    const lineItems = [
      buildLineItem('1', 'Water heater installation', 1, 45000, 1, true, 'labor'),
      buildLineItem('2', 'Water Heater 50 gal', 1, 125000, 2, true, 'equipment'),
    ];

    const signals = detectMissingItems(lineItems, PLUMBING_MISSING_ITEM_RULES, 'plumb-install-waterheater');
    const permitSignal = signals.find((s) => s.suggestedDescription.includes('Permit'));
    expect(permitSignal).toBeTruthy();
  });

  it('detects missing old unit disposal for water heater replacement', () => {
    const lineItems = [
      buildLineItem('1', 'Water heater install labor', 1, 45000, 1, true, 'labor'),
      buildLineItem('2', 'Water Heater replacement unit', 1, 125000, 2, true, 'equipment'),
    ];

    const signals = detectMissingItems(lineItems, PLUMBING_MISSING_ITEM_RULES, 'plumb-install-waterheater');
    const disposalSignal = signals.find((s) => s.suggestedDescription.includes('disposal'));
    expect(disposalSignal).toBeTruthy();
  });

  it('returns empty signals for non-matching category', () => {
    const lineItems = [
      buildLineItem('1', 'General repair', 1, 10000, 1, true, 'labor'),
    ];

    const signals = detectMissingItems(lineItems, HVAC_MISSING_ITEM_RULES, 'non-existent-category');
    // Only wildcard rules should match
    const nonWildcard = signals.filter((s) => s.suggestedDescription !== 'Labor');
    expect(nonWildcard).toHaveLength(0);
  });

  it('skips inactive rules', () => {
    const inactiveRules = HVAC_MISSING_ITEM_RULES.map((r) => ({ ...r, isActive: false }));
    const lineItems = [
      buildLineItem('1', 'AC Unit', 1, 350000, 1, true, 'equipment'),
    ];

    const signals = detectMissingItems(lineItems, inactiveRules, 'hvac-install-ac');
    expect(signals).toHaveLength(0);
  });
});
