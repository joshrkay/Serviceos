import { z } from 'zod';

/**
 * LC-1 — canonical inbound-lead contract.
 *
 * Single source of truth for the shape an *external* channel (website form,
 * partner marketplace adapter) may submit to create a lead. The authenticated
 * CRM create path keeps its own richer schema server-side
 * (`packages/api/src/leads/enums.ts` `createLeadSchema`); this contract is the
 * narrow, untrusted-input gate used by the public lead-intake webhook.
 *
 * Parsing a malformed payload throws a ZodError whose `.issues` carry the
 * field path + message, which the API surfaces as field-level errors via
 * `toErrorResponse`.
 *
 * Kept in lockstep with the `leads.source` CHECK constraint (the inbound
 * subset) and the `raw_payload` JSONB column (migration 204).
 */

/**
 * Sources an external channel is allowed to self-declare. A subset of the full
 * `LEAD_SOURCES` set: internal-origin sources (`phone_call`, `sms`,
 * `walk_in`, `customer_portal`) are minted by trusted server paths and must
 * NOT be forgeable from an inbound webhook. Partner marketplaces
 * (LSA / Angi / Thumbtack) map onto `marketplace`.
 */
export const INBOUND_LEAD_SOURCES = [
  'web_form',
  'marketplace',
  'referral',
  'other',
] as const;
export type InboundLeadSource = (typeof INBOUND_LEAD_SOURCES)[number];
export const inboundLeadSourceSchema = z.enum(INBOUND_LEAD_SOURCES);

/**
 * Curated marketing attribution bag. Open shape (any string key) so new UTM-
 * style params don't need a schema change; capped to 20 entries / 500-char
 * values to bound abuse. Mirrors the API-side `attributionSchema`.
 */
export const inboundAttributionSchema = z
  .record(z.string().max(100), z.string().max(500))
  .refine((v) => Object.keys(v).length <= 20, {
    message: 'attribution may have at most 20 entries',
  });

/** Max serialized size of the retained raw payload (16 KiB). */
export const MAX_RAW_PAYLOAD_BYTES = 16_384;

/**
 * The verbatim inbound submission, retained on the lead for the inbox. Must be
 * a JSON object (not an array/scalar) so it maps cleanly to the JSONB column,
 * and is size-capped so a hostile form can't bloat the row.
 */
export const inboundRawPayloadSchema = z
  .record(z.string(), z.unknown())
  .refine(
    (v) => JSON.stringify(v).length <= MAX_RAW_PAYLOAD_BYTES,
    { message: `raw payload exceeds ${MAX_RAW_PAYLOAD_BYTES} bytes` },
  );

export const inboundLeadSchema = z
  .object({
    source: inboundLeadSourceSchema,
    firstName: z.string().trim().min(1).max(100).optional(),
    lastName: z.string().trim().max(100).optional(),
    companyName: z.string().trim().min(1).max(200).optional(),
    primaryPhone: z.string().trim().min(7).max(40).optional(),
    email: z.string().trim().email().max(200).optional(),
    sourceDetail: z.string().trim().max(500).optional(),
    utmSource: z.string().trim().max(200).optional(),
    utmMedium: z.string().trim().max(200).optional(),
    utmCampaign: z.string().trim().max(200).optional(),
    attribution: inboundAttributionSchema.optional(),
    /** Verbatim original submission, retained on the lead (migration 204). */
    rawPayload: inboundRawPayloadSchema.optional(),
    /**
     * LC-3: explicit SMS consent. Only when `true` does the speed-to-lead
     * SMS auto-response fire (the form must capture a disclosure). Absent /
     * false ⇒ no SMS; DNC is always honored regardless.
     */
    smsConsent: z.boolean().optional(),
  })
  .refine((v) => Boolean(v.firstName || v.companyName), {
    message: 'firstName or companyName is required',
    path: ['firstName'],
  })
  .refine((v) => Boolean(v.primaryPhone || v.email), {
    message: 'A primaryPhone or email is required so we can reach you',
    path: ['primaryPhone'],
  });

export type InboundLead = z.infer<typeof inboundLeadSchema>;
