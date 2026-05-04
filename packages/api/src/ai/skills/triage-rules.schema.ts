/**
 * Zod schema + types for `corpus/data/triage-rules.json`.
 *
 * The triage rules file is hand-authored data that drives the
 * `classify-urgency-tier` skill. A Zod schema gives us:
 *   1. Compile-time types for callers (no `any` leaking into the
 *      classifier).
 *   2. Run-time validation when the JSON is loaded — catches typos in
 *      tier keys, malformed conditional phrases, missing fields.
 *
 * Loaded once at app boot via `loadTriageRules()`. The function throws
 * loudly on validation failure rather than letting bad rules silently
 * poison classification — better to fail-fast at boot than to
 * mis-classify a gas leak in production.
 */

import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { describeAtomGrammar, findUnknownAtoms } from './condition-grammar';

export const TIER_KEYS = [
  'TIER_1_EVACUATE',
  'TIER_2_EMERGENCY_DISPATCH',
  'TIER_3_SAME_DAY_URGENT',
  'TIER_4_SCHEDULE',
] as const;

export type TierKey = (typeof TIER_KEYS)[number];
const tierKeyEnum = z.enum(TIER_KEYS);

/**
 * Phase 4d-1 review carryover (Issue #2): condition expressions are
 * lint-checked at boot. A typo like `elderly_present` (instead of
 * `elderly`) would otherwise silently never fire — invisible to the
 * classifier but real to dispatchers reviewing the eval-run table
 * weeks later. We catch it here and refuse to load the rules at all.
 */
const conditionExpressionSchema = z.string().min(1).superRefine((value, ctx) => {
  const unknown = findUnknownAtoms(value);
  if (unknown.length === 0) return;
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message:
      `Unknown atom(s) in condition: ${unknown.join(', ')}. ` +
      describeAtomGrammar(),
  });
});

const conditionalPhraseSchema = z.object({
  phrase: z.string().min(1),
  /** Lint-validated expression. See condition-grammar.ts for the
   *  allowed atom catalogue + operator grammar. */
  condition: conditionExpressionSchema,
  escalate_to: tierKeyEnum,
  /** Tier to use when the condition is FALSE. Optional — when absent,
   *  the condition acts as a hard requirement (no match if false). */
  otherwise: tierKeyEnum.optional(),
});
export type ConditionalPhrase = z.infer<typeof conditionalPhraseSchema>;

const triggerWordTierSchema = z.object({
  description: z.string().optional(),
  phrases: z.array(z.string().min(1)).optional(),
  secondary_escalation: z.array(z.string().min(1)).optional(),
  conditional_phrases: z.array(conditionalPhraseSchema).optional(),
  response_script: z.string().optional(),
});

const multiFixtureRuleSchema = z.object({
  description: z.string().optional(),
  trigger: z.string().optional(),
  detection_phrases: z.array(z.string().min(1)).optional(),
  action: z.string().optional(),
});

const seasonalAdjustmentSchema = z.object({
  season: z.string().min(1),
  rule: z.string().min(1),
});

const falsePositiveGuardSchema = z.object({
  trigger_phrase: z.string().min(1),
  context: z.string(),
  classification: z.string().min(1),
  action: z.string().min(1),
  response_script: z.string().optional(),
});
export type FalsePositiveGuard = z.infer<typeof falsePositiveGuardSchema>;

export const triageRulesSchema = z.object({
  _meta: z
    .object({
      description: z.string().optional(),
      version: z.string().optional(),
      urgency_tiers: z.array(z.string()).optional(),
    })
    .optional(),
  trigger_words: z.record(tierKeyEnum, triggerWordTierSchema),
  multi_fixture_rule: multiFixtureRuleSchema.optional(),
  seasonal_adjustments: z.array(seasonalAdjustmentSchema).optional(),
  // The remaining sections (`triage_questions`, `job_type_intake_questions`)
  // are not consumed by the urgency classifier; we accept them
  // permissively so the file can carry data for other skills.
  triage_questions: z.unknown().optional(),
  job_type_intake_questions: z.unknown().optional(),
  false_positive_guards: z.array(falsePositiveGuardSchema).optional(),
});

export type TriageRules = z.infer<typeof triageRulesSchema>;

/**
 * Load triage rules from the canonical JSON file. Throws on invalid
 * data so callers fail at boot rather than at classification time.
 *
 * The default path resolves the corpus from the API package's
 * monorepo root (`../../../corpus/data/triage-rules.json` relative to
 * this file). Tests pass an explicit path or pre-parsed object.
 */
export function loadTriageRules(jsonText: string): TriageRules {
  const raw: unknown = JSON.parse(jsonText);
  return triageRulesSchema.parse(raw);
}

export function loadTriageRulesFromFile(absolutePath: string): TriageRules {
  const text = readFileSync(absolutePath, 'utf8');
  return loadTriageRules(text);
}
