/**
 * P9-001 — Lead pipeline enums + Zod schemas.
 *
 * Lead enums live here (NOT in `packages/shared/src/enums.ts`) per the
 * P9-001 dispatch contract — that file is Tier-1 frozen for the wave.
 */
import { z } from 'zod';

export const LEAD_SOURCES = [
  'web_form',
  'phone_call',
  'referral',
  'walk_in',
  'marketplace',
  'other',
] as const;
export type LeadSource = (typeof LEAD_SOURCES)[number];

export const LEAD_STAGES = [
  'new',
  'contacted',
  'qualified',
  'quoted',
  'won',
  'lost',
] as const;
export type LeadStage = (typeof LEAD_STAGES)[number];

export const leadSourceSchema = z.enum(LEAD_SOURCES);
export const leadStageSchema = z.enum(LEAD_STAGES);

/**
 * Money is integer cents — never float / decimal.
 * Reject decimals, NaN, negatives. We allow a wide cap (BIGINT in pg).
 */
export const estimatedValueCentsSchema = z
  .number()
  .int('estimatedValueCents must be an integer (cents)')
  .nonnegative('estimatedValueCents must be >= 0')
  .finite();

export const createLeadSchema = z.object({
  firstName: z.string().min(1).max(100).optional(),
  lastName: z.string().min(1).max(100).optional(),
  companyName: z.string().min(1).max(200).optional(),
  primaryPhone: z.string().min(1).max(40).optional(),
  email: z.string().email().optional(),
  source: leadSourceSchema,
  sourceDetail: z.string().max(500).optional(),
  estimatedValueCents: estimatedValueCentsSchema.optional(),
  notes: z.string().max(5000).optional(),
  assignedUserId: z.string().uuid().optional(),
  // stage defaults to 'new' on create — callers may not set it.
}).refine(
  (v) => Boolean(v.firstName || v.companyName),
  { message: 'firstName or companyName is required' }
);

export const updateLeadSchema = z.object({
  firstName: z.string().min(1).max(100).optional(),
  lastName: z.string().min(1).max(100).optional(),
  companyName: z.string().min(1).max(200).optional(),
  primaryPhone: z.string().min(1).max(40).optional(),
  email: z.string().email().optional().or(z.literal('')),
  source: leadSourceSchema.optional(),
  sourceDetail: z.string().max(500).optional(),
  stage: leadStageSchema.optional(),
  estimatedValueCents: estimatedValueCentsSchema.nullable().optional(),
  notes: z.string().max(5000).optional(),
  assignedUserId: z.string().uuid().nullable().optional(),
});

export const loseLeadSchema = z.object({
  reason: z.string().min(1, 'reason is required').max(500),
});
