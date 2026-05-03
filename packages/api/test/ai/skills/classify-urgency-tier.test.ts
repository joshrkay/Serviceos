import { describe, it, expect, beforeAll } from 'vitest';
import { resolve } from 'node:path';
import { classifyUrgencyTier } from '../../../src/ai/skills/classify-urgency-tier';
import {
  loadTriageRulesFromFile,
  type TriageRules,
} from '../../../src/ai/skills/triage-rules.schema';

const TRIAGE_RULES_PATH = resolve(
  __dirname,
  '../../../../../corpus/data/triage-rules.json',
);

let rules: TriageRules;

describe('classifyUrgencyTier', () => {
  beforeAll(() => {
    rules = loadTriageRulesFromFile(TRIAGE_RULES_PATH);
  });

  describe('TIER_1_EVACUATE — life safety', () => {
    it('classifies "I smell gas" as TIER_1 with requiresEvacuation', () => {
      const r = classifyUrgencyTier({ utterance: 'I smell gas in the house' }, rules);
      expect(r.tier).toBe('TIER_1_EVACUATE');
      expect(r.requiresEvacuation).toBe(true);
      expect(r.matchedPhrases).toContain('smell gas');
      expect(r.responseScript).toMatch(/leave the building immediately/i);
    });

    it('classifies CO detector going off as TIER_1', () => {
      const r = classifyUrgencyTier(
        { utterance: 'my carbon monoxide detector going off in the basement' },
        rules,
      );
      expect(r.tier).toBe('TIER_1_EVACUATE');
      expect(r.requiresEvacuation).toBe(true);
    });
  });

  describe('TIER_2_EMERGENCY_DISPATCH — dispatch immediately', () => {
    it('classifies flooding as TIER_2', () => {
      const r = classifyUrgencyTier(
        { utterance: 'my basement is flooded and water is everywhere' },
        rules,
      );
      expect(r.tier).toBe('TIER_2_EMERGENCY_DISPATCH');
      expect(r.requiresEvacuation).toBe(false);
      expect(r.matchedPhrases.some((p) => p === 'flooded' || p === 'water everywhere'),
      ).toBe(true);
    });

    it('classifies burst pipe as TIER_2', () => {
      const r = classifyUrgencyTier(
        { utterance: 'I think a pipe burst in the wall' },
        rules,
      );
      expect(r.tier).toBe('TIER_2_EMERGENCY_DISPATCH');
    });

    it('escalates "no heat" to TIER_2 when winter conditional is met (outdoor temp below 40)', () => {
      const r = classifyUrgencyTier(
        {
          utterance: 'we have no heat in the house',
          context: { outdoorTempF: 28 },
        },
        rules,
      );
      expect(r.tier).toBe('TIER_2_EMERGENCY_DISPATCH');
      expect(r.matchedPhrases).toContain('no heat');
    });

    it('falls back to TIER_3 for "no heat" when temperature is mild', () => {
      const r = classifyUrgencyTier(
        {
          utterance: 'we have no heat in the house',
          context: { outdoorTempF: 65 },
        },
        rules,
      );
      expect(r.tier).toBe('TIER_3_SAME_DAY_URGENT');
    });

    it('escalates "no AC" to TIER_2 when summer + elderly resident present', () => {
      const r = classifyUrgencyTier(
        {
          utterance: 'no AC and my mom is here, she is 78',
          context: { outdoorTempF: 95, hasElderly: true },
        },
        rules,
      );
      // "no AC" matches the conditional phrase in TIER_3 with the
      // summer-elderly escalator → TIER_2.
      expect(r.tier).toBe('TIER_2_EMERGENCY_DISPATCH');
    });
  });

  describe('TIER_3_SAME_DAY_URGENT', () => {
    it('classifies no hot water as TIER_3 when single-family home context is set', () => {
      const r = classifyUrgencyTier(
        {
          utterance: 'no hot water at all this morning',
          context: { isSingleFamilyHome: true },
        },
        rules,
      );
      expect(r.tier).toBe('TIER_3_SAME_DAY_URGENT');
    });

    it('escalates single-drain backup to TIER_3 via multi-fixture rule when multiple drains affected', () => {
      const r = classifyUrgencyTier(
        {
          utterance: 'all my drains are slow and water comes up in the bathtub when I flush the toilet',
        },
        rules,
      );
      expect(r.tier).toBe('TIER_3_SAME_DAY_URGENT');
      expect(r.multiFixtureEscalation).toBe(true);
    });
  });

  describe('TIER_4_SCHEDULE — non-urgent default', () => {
    it('classifies a dripping faucet as TIER_4', () => {
      const r = classifyUrgencyTier(
        { utterance: 'I have a dripping faucet in the kitchen' },
        rules,
      );
      expect(r.tier).toBe('TIER_4_SCHEDULE');
      expect(r.requiresEvacuation).toBe(false);
    });

    it('falls back to TIER_4 when no rule matches', () => {
      const r = classifyUrgencyTier(
        { utterance: 'just calling to get a quote on a new garbage disposal' },
        rules,
      );
      expect(r.tier).toBe('TIER_4_SCHEDULE');
      expect(r.matchedPhrases).toEqual([]);
      expect(r.rationale).toMatch(/no urgency triggers matched/i);
    });
  });

  describe('false-positive guards', () => {
    it('does NOT escalate "steam coming off the outdoor unit" in winter — heat pump defrost', () => {
      const r = classifyUrgencyTier(
        {
          utterance: 'I see steam coming off the outdoor unit, is that bad?',
          context: { season: 'winter', outdoorTempF: 30 },
        },
        rules,
      );
      expect(r.tier).toBe('TIER_4_SCHEDULE');
      expect(r.falsePositiveGuard).toBeDefined();
      expect(r.falsePositiveGuard!.classification).toMatch(/heat pump defrost/i);
    });

    it('does NOT trigger heat-pump-defrost guard outside winter context', () => {
      const r = classifyUrgencyTier(
        {
          utterance: 'I see steam coming off the outdoor unit',
          context: { season: 'summer', outdoorTempF: 85 },
        },
        rules,
      );
      // Without the winter-context guard, no other rule matches steam,
      // so it falls through to TIER_4 BUT without the falsePositiveGuard
      // attribution.
      expect(r.falsePositiveGuard).toBeUndefined();
    });
  });

  describe('seasonal adjustments', () => {
    it('escalates frozen-pipe report to TIER_2 during spring_freeze_warning', () => {
      // "pipes froze" is a TIER_2 conditional/phrase; the seasonal rule
      // ensures it stays TIER_2 even if some other code path tried to
      // de-escalate later.
      const r = classifyUrgencyTier(
        {
          utterance: 'pipes froze last night, no water coming out',
          context: { season: 'spring_freeze_warning' },
        },
        rules,
      );
      expect(r.tier).toBe('TIER_2_EMERGENCY_DISPATCH');
    });

    it('escalates HVAC won\'t-turn-on from TIER_4 to TIER_3 post-storm', () => {
      const r = classifyUrgencyTier(
        {
          utterance: "the AC won't turn on after the storm",
          context: { season: 'post_storm_power_outage' },
        },
        rules,
      );
      expect(r.tier).toBe('TIER_3_SAME_DAY_URGENT');
    });
  });

  describe('audit trail', () => {
    it('rationale includes matched phrases for explainability', () => {
      const r = classifyUrgencyTier({ utterance: 'sewage backup in my basement' }, rules);
      expect(r.tier).toBe('TIER_2_EMERGENCY_DISPATCH');
      expect(r.rationale).toMatch(/sewage backup/);
    });

    it('returns empty matchedPhrases on TIER_4 default fallthrough', () => {
      const r = classifyUrgencyTier(
        { utterance: 'just curious about pricing' },
        rules,
      );
      expect(r.matchedPhrases).toEqual([]);
    });
  });
});
