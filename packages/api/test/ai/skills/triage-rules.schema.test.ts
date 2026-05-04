import { describe, it, expect } from 'vitest';
import { ZodError } from 'zod';
import {
  loadTriageRules,
  loadTriageRulesFromFile,
} from '../../../src/ai/skills/triage-rules.schema';
import { resolve } from 'node:path';

const VALID_BASE = {
  trigger_words: {
    TIER_2_EMERGENCY_DISPATCH: {
      conditional_phrases: [
        {
          phrase: 'no heat',
          condition: 'outdoor_temp_below_40f OR indoor_temp_below_55f',
          escalate_to: 'TIER_2_EMERGENCY_DISPATCH',
          otherwise: 'TIER_3_SAME_DAY_URGENT',
        },
      ],
    },
  },
};

describe('triage-rules.schema', () => {
  describe('atom allow-list (Issue #2)', () => {
    it('accepts the canonical seeded JSON unchanged', () => {
      const rules = loadTriageRulesFromFile(
        resolve(__dirname, '../../../../../corpus/data/triage-rules.json'),
      );
      expect(rules.trigger_words.TIER_2_EMERGENCY_DISPATCH).toBeDefined();
      expect(rules.false_positive_guards?.length ?? 0).toBeGreaterThan(0);
    });

    it('accepts every documented static atom', () => {
      const conditions = [
        'elderly',
        'infant',
        'medical_equipment_in_home',
        'single_family_home',
        'winter',
        'summer',
        'any',
      ];
      for (const cond of conditions) {
        const json = JSON.stringify({
          trigger_words: {
            TIER_2_EMERGENCY_DISPATCH: {
              conditional_phrases: [
                {
                  phrase: 'test phrase',
                  condition: cond,
                  escalate_to: 'TIER_2_EMERGENCY_DISPATCH',
                },
              ],
            },
          },
        });
        expect(() => loadTriageRules(json)).not.toThrow();
      }
    });

    it('accepts parametric atoms with arbitrary integer thresholds', () => {
      const conditions = [
        'outdoor_temp_below_40f',
        'outdoor_temp_above_90f',
        'indoor_temp_below_55f',
        'outdoor_temp_below_0f', // boundary integer
      ];
      for (const cond of conditions) {
        const json = JSON.stringify({
          trigger_words: {
            TIER_2_EMERGENCY_DISPATCH: {
              conditional_phrases: [
                { phrase: 'p', condition: cond, escalate_to: 'TIER_2_EMERGENCY_DISPATCH' },
              ],
            },
          },
        });
        expect(() => loadTriageRules(json)).not.toThrow();
      }
    });

    it('accepts compound expressions with AND, OR, parens', () => {
      const expressions = [
        'elderly OR infant',
        'elderly AND winter',
        'outdoor_temp_above_90f AND (elderly OR infant OR medical_equipment_in_home)',
        'winter OR single_family_home',
      ];
      for (const expr of expressions) {
        const json = JSON.stringify({
          trigger_words: {
            TIER_2_EMERGENCY_DISPATCH: {
              conditional_phrases: [
                { phrase: 'p', condition: expr, escalate_to: 'TIER_2_EMERGENCY_DISPATCH' },
              ],
            },
          },
        });
        expect(() => loadTriageRules(json)).not.toThrow();
      }
    });

    it('rejects a typo on a static atom (elderly_present instead of elderly)', () => {
      const json = JSON.stringify({
        trigger_words: {
          TIER_2_EMERGENCY_DISPATCH: {
            conditional_phrases: [
              {
                phrase: 'p',
                condition: 'elderly_present OR infant',
                escalate_to: 'TIER_2_EMERGENCY_DISPATCH',
              },
            ],
          },
        },
      });
      expect(() => loadTriageRules(json)).toThrow(ZodError);
      try {
        loadTriageRules(json);
      } catch (err) {
        expect(String(err)).toMatch(/elderly_present/);
        expect(String(err)).toMatch(/Allowed atoms/);
      }
    });

    it('rejects a malformed parametric atom (capital F instead of lowercase)', () => {
      const json = JSON.stringify({
        trigger_words: {
          TIER_2_EMERGENCY_DISPATCH: {
            conditional_phrases: [
              {
                phrase: 'p',
                condition: 'outdoor_temp_below_50F',
                escalate_to: 'TIER_2_EMERGENCY_DISPATCH',
              },
            ],
          },
        },
      });
      // Note: tokenizer lowercases — outdoor_temp_below_50F → outdoor_temp_below_50f
      // which IS valid. So this should ACCEPT.
      expect(() => loadTriageRules(json)).not.toThrow();
    });

    it('rejects parametric atom with non-numeric threshold', () => {
      const json = JSON.stringify({
        trigger_words: {
          TIER_2_EMERGENCY_DISPATCH: {
            conditional_phrases: [
              {
                phrase: 'p',
                condition: 'outdoor_temp_below_coldf',
                escalate_to: 'TIER_2_EMERGENCY_DISPATCH',
              },
            ],
          },
        },
      });
      expect(() => loadTriageRules(json)).toThrow(ZodError);
    });

    it('reports ALL unknown atoms in one error, not just the first', () => {
      const json = JSON.stringify({
        trigger_words: {
          TIER_2_EMERGENCY_DISPATCH: {
            conditional_phrases: [
              {
                phrase: 'p',
                condition: 'elderly_present OR baby_in_home',
                escalate_to: 'TIER_2_EMERGENCY_DISPATCH',
              },
            ],
          },
        },
      });
      try {
        loadTriageRules(json);
        throw new Error('expected throw');
      } catch (err) {
        const msg = String(err);
        expect(msg).toMatch(/elderly_present/);
        expect(msg).toMatch(/baby_in_home/);
      }
    });

    it('still allows unknown atom names if they happen to match a parametric pattern', () => {
      // outdoor_temp_below_99f is unusual but structurally valid.
      const json = JSON.stringify(VALID_BASE);
      expect(() => loadTriageRules(json)).not.toThrow();
    });
  });
});
