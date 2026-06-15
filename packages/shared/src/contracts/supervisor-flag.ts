/**
 * P2-037 — Supervisor agent review flags.
 */
import { z } from 'zod';

export const supervisorFlagTypeSchema = z.enum([
  'missed_urgency',
  'pricing_anomaly',
  'brand_voice_drift',
  'account_routing_error',
]);

export type SupervisorFlagType = z.infer<typeof supervisorFlagTypeSchema>;

export const supervisorFlagSeveritySchema = z.enum(['low', 'medium', 'high']);

export type SupervisorFlagSeverity = z.infer<typeof supervisorFlagSeveritySchema>;

export const supervisorFlagSchema = z.object({
  type: supervisorFlagTypeSchema,
  severity: supervisorFlagSeveritySchema,
  explanation: z.string(),
});

export type SupervisorFlag = z.infer<typeof supervisorFlagSchema>;

export const supervisorReviewSchema = z.object({
  flags: z.array(supervisorFlagSchema),
  reviewedAt: z.string(),
  skipped: z.boolean().optional(),
});

export type SupervisorReview = z.infer<typeof supervisorReviewSchema>;
