/**
 * VQ-001 — Voice Quality v1: Zod schemas for corpus scripts and rubric versioning.
 *
 * `VoiceQualityScriptSchema` defines the shape of a single corpus script
 * (one file per script under `corpus/scripts/<bucket>/*.json`). The Layer 1
 * runner loads + validates every script through this schema before driving
 * it through the agent.
 *
 * `RubricSchema` defines the shape of a versioned rubric (`rubric.vN.json`).
 * Each criterion has an integer id, a stable `name` (used by graders to key
 * pass/fail reasons), a `layer` (`floor` = hard, `disposition` = soft), and
 * a `gradedBy` indicator that selects which grader implementation owns it.
 */
import { z } from 'zod';

export const VOICE_QUALITY_BUCKETS = [
  '01-happy-lookups',
  '02-happy-booker',
  '03-lead-capture',
  '04-identity-edges',
  '05-compliance-edges',
  '06-hangup-edges',
  '07-out-of-scope',
  '08-ambiguity',
  '09-concurrency',
  '10-adversarial',
] as const;

export const VoiceQualityScriptSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  bucket: z.enum(VOICE_QUALITY_BUCKETS),
  fixtures: z.object({
    tenant: z.record(z.unknown()),
    customers: z.array(z.unknown()),
    appointments: z.array(z.unknown()).optional(),
    invoices: z.array(z.unknown()).optional(),
  }),
  callerId: z.string().nullable(),
  callerIdBlocked: z.boolean().default(false),
  turns: z.array(
    z.object({
      caller: z.string(),
      expected: z.object({
        intent: z.string().optional(),
        slots: z.record(z.unknown()).optional(),
        proposalType: z.string().optional(),
        escalates: z.boolean().optional(),
        spokenAnswerMatches: z.string().optional(),
      }),
      hangupAfter: z.boolean().default(false),
    }),
  ),
  grading: z.object({
    appliesFloor: z.array(z.number().int().min(1).max(8)),
    appliesDisposition: z.array(z.number().int().min(9).max(12)),
  }),
  layer2Eligible: z.boolean().default(false),
  /**
   * VQ2-014 — when `true`, the script is excluded from Layer 1 (cassettes
   * cannot fairly grade audio-only edge cases like mumbled speech or
   * mid-sentence pauses) and included in Layer 2 only. A script with
   * `layer2Only: true` MUST also have `layer2Eligible: true`. The Layer 1
   * runner filters these out; the Layer 2 corpus loader includes them
   * via `loadLayer2Corpus()`.
   */
  layer2Only: z.boolean().default(false),
});

export type VoiceQualityScript = z.infer<typeof VoiceQualityScriptSchema>;
export type VoiceQualityBucket = (typeof VOICE_QUALITY_BUCKETS)[number];

/** Rubric version identifier — bump when criteria are added/removed/redefined. */
export const RubricVersionSchema = z.enum(['v1']);
export type RubricVersion = z.infer<typeof RubricVersionSchema>;

export const RubricCriterionSchema = z.object({
  id: z.number().int().min(1).max(12),
  name: z.string().min(1),
  layer: z.enum(['floor', 'disposition']),
  gradedBy: z.enum(['mechanical', 'llm', 'mixed']),
  description: z.string().min(1),
});
export type RubricCriterion = z.infer<typeof RubricCriterionSchema>;

export const RubricSchema = z.object({
  version: RubricVersionSchema,
  criteria: z.array(RubricCriterionSchema),
});
export type Rubric = z.infer<typeof RubricSchema>;
