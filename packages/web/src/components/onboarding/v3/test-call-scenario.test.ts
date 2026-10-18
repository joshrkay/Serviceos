import { describe, expect, it } from 'vitest';
import { testCallScenario } from './test-call-scenario';

describe('testCallScenario', () => {
  it('gives each supported trade its own line, ending with the same booking ask', () => {
    expect(testCallScenario('plumbing')).toMatch(/slow drain/);
    expect(testCallScenario('hvac')).toMatch(/AC is blowing warm/);
    expect(testCallScenario('electrical')).toMatch(/breaker keeps tripping/);
    for (const trade of ['plumbing', 'hvac', 'electrical']) expect(testCallScenario(trade)).toMatch(/Ask for next Tuesday\.$/);
  });

  it('falls back to a trade-neutral line for anything else, including no pack', () => {
    const generic = testCallScenario('other');
    expect(generic).not.toMatch(/drain|AC|breaker/);
    expect(generic).toMatch(/Ask for next Tuesday\.$/);
    expect(testCallScenario(null)).toBe(generic);
    expect(testCallScenario(undefined)).toBe(generic);
    expect(testCallScenario('painting')).toBe(generic);
  });
});
