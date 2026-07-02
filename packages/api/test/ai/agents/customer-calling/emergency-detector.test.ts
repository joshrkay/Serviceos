import { describe, it, expect } from 'vitest';
import {
  detectEmergency,
  EMERGENCY_KEYWORDS,
  EMERGENCY_SAFETY_LINE,
} from '../../../../src/ai/agents/customer-calling/emergency-detector';

describe('RV-140 — detectEmergency (deterministic keyword scan)', () => {
  it.each([
    ['I think we have a gas leak in the basement', 'gas leak'],
    ['it smells like gas down here', 'smells like gas'],
    ['my carbon monoxide alarm is going off', 'carbon monoxide'],
    ['the water heater caught fire', 'caught fire'],
    ['the outlet is sparking', 'sparking'],
    ['I smell electrical burning from the panel', 'electrical burning'],
    ['the basement is flooding fast', 'flooding'],
    ['we have a burst pipe upstairs', 'burst pipe'],
  ])('matches %j', (utterance, keyword) => {
    const result = detectEmergency(utterance);
    expect(result.matched).toBe(true);
    expect(result.keyword).toBe(keyword);
  });

  it('matches the compound no-heat + at-risk phrasing', () => {
    const result = detectEmergency(
      "our heat is out and it's freezing and we have a newborn",
    );
    expect(result.matched).toBe(true);
    expect(result.keyword).toContain('heat is out');
  });

  it('does NOT match a plain no-heat report without the risk phrasing', () => {
    expect(detectEmergency('my furnace is out, can you send someone next week').matched).toBe(false);
  });

  it('does NOT match routine scheduling language', () => {
    expect(detectEmergency('I want to book my annual AC tune-up').matched).toBe(false);
    expect(detectEmergency('can you fire over the estimate again').matched).toBe(false);
    expect(detectEmergency('the gas station on main street').matched).toBe(false);
  });

  it('is case-insensitive and word-bounded', () => {
    expect(detectEmergency('GAS LEAK!!').matched).toBe(true);
    // 'sparkling' must not hit 'sparking'.
    expect(detectEmergency('the sparkling water dispenser is broken').matched).toBe(false);
  });

  it('keyword table is non-empty platform defaults (per-tenant merge is out of scope)', () => {
    expect(EMERGENCY_KEYWORDS.length).toBeGreaterThan(5);
  });

  it('safety line references 911', () => {
    expect(EMERGENCY_SAFETY_LINE).toContain('911');
  });
});

// ─── UB-C3 — Spanish emergency keywords (scanned unconditionally) ────────────

describe('UB-C3 — detectEmergency Spanish keywords', () => {
  it.each([
    ['creo que hay una fuga de gas en el sótano', 'fuga de gas'],
    ['huele a gas aquí abajo', 'huele a gas'],
    ['la alarma de monóxido de carbono está sonando', 'monóxido de carbono'],
    ['la alarma de monoxido de carbono esta sonando', 'monoxido de carbono'],
    ['hay un incendio en la cocina', 'incendio'],
    ['el calentador se está quemando', 'se está quemando'],
    ['el calentador se esta quemando ahora', 'se esta quemando'],
    ['tenemos una inundación en el sótano', 'inundación'],
    ['el sótano está inundado', 'inundado'],
    ['hay una tubería rota arriba', 'tubería rota'],
    ['el enchufe está echando chispas', 'echando chispas'],
    ['es una emergencia, por favor', 'emergencia'],
    ['mi esposo no puede respirar por el humo', 'no puede respirar'],
  ])('matches %j', (utterance, keyword) => {
    const result = detectEmergency(utterance);
    expect(result.matched).toBe(true);
    expect(result.keyword).toBe(keyword);
  });

  // The Spanish rows live in the SAME unconditional table as English —
  // a Spanish speaker on an 'English' call still says "fuga de gas".
  it('Spanish keywords are in the unconditional EMERGENCY_KEYWORDS table', () => {
    expect(EMERGENCY_KEYWORDS).toContain('fuga de gas');
    expect(EMERGENCY_KEYWORDS).toContain('incendio');
    expect(EMERGENCY_KEYWORDS).toContain('inundación');
    expect(EMERGENCY_KEYWORDS).toContain('se está quemando');
    expect(EMERGENCY_KEYWORDS).toContain('monóxido de carbono');
    expect(EMERGENCY_KEYWORDS).toContain('emergencia');
    expect(EMERGENCY_KEYWORDS).toContain('no puedo respirar');
  });

  it('matches the Spanish compound no-heat + at-risk phrasing', () => {
    const result = detectEmergency(
      'no hay calefacción y estamos bajo cero con un bebé en casa',
    );
    expect(result.matched).toBe(true);
    expect(result.keyword).toContain('no hay calefacción');
  });

  it('does NOT match a plain Spanish no-heat report without the risk phrasing', () => {
    expect(
      detectEmergency('no hay calefacción, ¿pueden mandar a alguien la próxima semana?').matched,
    ).toBe(false);
  });

  it('does NOT match routine Spanish scheduling language', () => {
    expect(detectEmergency('quiero agendar el mantenimiento anual del aire').matched).toBe(false);
    expect(detectEmergency('mi calentador de agua hace un ruido raro y no calienta bien').matched).toBe(false);
    expect(detectEmergency('el desagüe del fregadero está tapado y se está desbordando').matched).toBe(false);
    // "inundadora" / "emergenciasas" style superstrings must not hit.
    expect(detectEmergency('la impresora está descompuesta').matched).toBe(false);
  });

  it('is case/accent-edge safe: accented phrase edges match with word boundaries', () => {
    expect(detectEmergency('¡FUGA DE GAS!').matched).toBe(true);
    // 'bebé' ends in an accented char — ASCII \b would silently fail here.
    expect(detectEmergency('sin calefacción y hay un bebé').matched).toBe(true);
    // superstring containing 'emergencia' must not hit via substring.
    expect(detectEmergency('llamé a emergenciasalud ayer').matched).toBe(false);
  });
});
