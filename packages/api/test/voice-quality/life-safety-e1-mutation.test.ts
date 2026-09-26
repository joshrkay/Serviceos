/**
 * #1222 acceptance: "Confirm the scripts go RED when E1 detection is removed."
 *
 * Machine-checked, not a one-off manual experiment. The production tier
 * classifier is replaced with a MUTANT whose E1 detection is gone, the
 * life-safety corpus is run through the real Layer 1 runner + graders, and
 * every E1 script must FAIL its rubric. Two mutants:
 *   - `downgrade-to-E2`: the pre-#1222 driver behaviour (every emergency
 *     treated as E2 — the exact blind spot that let es-emergency-escalation
 *     stay green before and after the #1056 fix);
 *   - `no-emergency`: detection deleted outright (everything E3).
 * With the real classifier (`off`), every script passes.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { loadCorpus } from '../../src/ai/voice-quality/corpus/loader';
import { runScript } from '../../src/ai/voice-quality/runner';
import { gradeLayer1Script } from '../../src/ai/voice-quality/grade-layer1';
import { createMockLLMGateway } from '../../src/ai/gateway/factory';
import {
  buildCassetteGatewayForScript,
  makeVoiceQualityDriverFactory,
} from './voice-quality-driver-factory';

type Mutant = 'off' | 'downgrade-to-E2' | 'no-emergency';
const mutant: { current: Mutant } = { current: 'off' };

vi.mock('../../src/ai/agents/customer-calling/emergency-tier', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/ai/agents/customer-calling/emergency-tier')>();
  return {
    ...real,
    classifyCallerSafety: (...args: Parameters<typeof real.classifyCallerSafety>) => {
      const result = real.classifyCallerSafety(...args);
      if (mutant.current === 'off' || result.tier !== 'E1') return result;
      if (mutant.current === 'downgrade-to-E2') {
        return { ...result, tier: 'E2' as const, requiresEvacuation: false, responseScript: null };
      }
      return {
        tier: 'E3' as const,
        requiresEvacuation: false,
        keyword: 'unknown',
        responseScript: null,
        source: 'none' as const,
      };
    },
  };
});

const lifeSafety = loadCorpus().filter(
  (s) =>
    s.bucket === '12-life-safety' || s.id === 'es-emergency-escalation',
);
const e1Scripts = lifeSafety.filter((s) => s.turns.some((t) => t.expected.safetyTier === 'E1'));

async function passes(script: (typeof lifeSafety)[number]): Promise<boolean> {
  const result = await runScript(script, {
    driverFactory: makeVoiceQualityDriverFactory(script),
    repoMode: 'memory',
    gatewayFactory: () => buildCassetteGatewayForScript(script),
  });
  const { gateway } = createMockLLMGateway(
    JSON.stringify({ answerMeaningMatches: true, softSlotsReasonable: true, rationale: 'pass' }),
  );
  const verdict = await gradeLayer1Script({
    observation: result.observation,
    script,
    gateway,
    durationMs: result.durationMs,
  });
  return verdict.passed;
}

describe('#1222 — the life-safety corpus goes RED when E1 detection is removed', () => {
  afterEach(() => {
    mutant.current = 'off';
  });

  it('covers E1 gas, CO, fire, electrical burning and injury in English and Spanish', () => {
    expect(e1Scripts.length).toBeGreaterThanOrEqual(10);
  });

  it('every life-safety script passes with the real tier classifier', async () => {
    for (const script of lifeSafety) {
      expect(await passes(script), script.id).toBe(true);
    }
  });

  it.each<Mutant>(['downgrade-to-E2', 'no-emergency'])(
    'mutant %s: every E1 script fails its rubric',
    async (m) => {
      mutant.current = m;
      const stillGreen: string[] = [];
      for (const script of e1Scripts) {
        if (await passes(script)) stillGreen.push(script.id);
      }
      expect(stillGreen, `E1 scripts that did not notice the mutant '${m}'`).toEqual([]);
    },
  );
});
