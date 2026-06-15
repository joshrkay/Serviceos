/**
 * P2-035 — Typed confidence markers (no numeric % badges).
 */
import { z } from 'zod';

export const confidenceMarkerTypeSchema = z.enum([
  'unknown_part',
  'price_deviation',
  'urgency_uncertain',
  'unverified_b2b_claim',
  'brand_voice_drift',
  'uncatalogued_price',
  'ambiguous_catalog',
  'ambiguous_entity',
]);

export type ConfidenceMarkerType = z.infer<typeof confidenceMarkerTypeSchema>;

export const confidenceMarkerSchema = z.object({
  type: confidenceMarkerTypeSchema,
  fieldPath: z.string().optional(),
  explanation: z.string(),
  aiRunId: z.string().optional(),
  lineIndex: z.number().int().nonnegative().optional(),
});

export type ConfidenceMarker = z.infer<typeof confidenceMarkerSchema>;
