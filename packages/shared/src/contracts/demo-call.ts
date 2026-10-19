/**
 * Wire contract for the pre-signup demo call (U7, "hear it answer").
 *
 *   POST /public/demo/calls  { phone, trade, businessName, metro? }
 *     202 { correlationId, status: 'calling' }
 *     400 | 429 | 502 | 503 { error, message }
 *
 * Unauthenticated: the API re-validates with this schema. Copy in `message`
 * is shown to the visitor as is, so it is plain words.
 */
import { z } from 'zod';

/** The trades a visitor can hear; the API's demo pool seeds exactly these packs. */
export const DEMO_CALL_TRADES = ['plumbing', 'hvac', 'electrical', 'painting'] as const;
export type DemoCallTrade = (typeof DEMO_CALL_TRADES)[number];

export const DEMO_CALL_BUSINESS_NAME_MAX = 80;

export const DemoCallStartInputSchema = z
  .object({
    /** The visitor's cell, as typed (E.164 or US national format). */
    phone: z.string().min(7).max(20),
    trade: z.enum(DEMO_CALL_TRADES),
    businessName: z.string().trim().min(1).max(DEMO_CALL_BUSINESS_NAME_MAX),
    /** A metro code the visitor picked; otherwise the API reads it from the area code. */
    metro: z.string().trim().min(1).max(64).optional(),
  })
  .strict();
export type DemoCallStartInput = z.infer<typeof DemoCallStartInputSchema>;

export const DemoCallStartResponseSchema = z
  .object({
    /** Reads the call's result later (S6-9). */
    correlationId: z.string().min(1),
    status: z.literal('calling'),
  })
  .strict();
export type DemoCallStartResponse = z.infer<typeof DemoCallStartResponseSchema>;

export const DEMO_CALL_ERROR_CODES = [
  'INVALID_INPUT',
  'DEMO_NUMBER_NOT_ALLOWED',
  'DEMO_DAILY_LIMIT',
  'DEMO_BUSY',
  'DEMO_DISABLED',
  'DEMO_CALL_FAILED',
] as const;
export type DemoCallErrorCode = (typeof DEMO_CALL_ERROR_CODES)[number];

export const DemoCallErrorSchema = z.object({ error: z.enum(DEMO_CALL_ERROR_CODES), message: z.string() }).strict();
export type DemoCallError = z.infer<typeof DemoCallErrorSchema>;
