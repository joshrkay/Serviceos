/**
 * P18-001 — `create_customer` proposal contract.
 *
 * The base Zod schema lives in `proposals/contracts.ts` and is wired
 * into `PROPOSAL_TYPE_SCHEMAS`. This file owns the voice-driven
 * extension: the payload shape produced by the
 * `CreateCustomerVoiceTaskHandler` includes the same `name` / `email`
 * / `phone` fields plus voice-specific provenance metadata (caller-id
 * source, classifier confidence, phone-blocked flag) so the approval
 * UI can show the operator who they're about to add and why.
 *
 * The voice-extended schema is a SUPERSET of the base schema — every
 * voice payload still validates against the base, so the executor's
 * `validateProposalPayload` gate continues to function unchanged.
 */
import { z } from 'zod';
import { createCustomerPayloadSchema } from '../contracts';

export type CreateCustomerPayload = z.infer<typeof createCustomerPayloadSchema>;

/**
 * Voice-call provenance for the proposal payload. Optional on the
 * base schema to keep operator-side flows (manual customer creation
 * from a screen tap) compatible.
 */
export const createCustomerVoiceMetadataSchema = z.object({
  /** Caller-ID phone source: 'caller_id' | 'spoken' | 'callback'. */
  phoneSource: z.enum(['caller_id', 'spoken', 'callback']).optional(),
  /** True when caller-ID was withheld / blocked / private. */
  phoneBlocked: z.boolean().optional(),
  /** Voice session id for joining audio + transcript at review time. */
  sessionId: z.string().optional(),
  /** Twilio CallSid (when known). */
  callSid: z.string().optional(),
  /** Classifier confidence when this was created from a voice intent. */
  classifierConfidence: z.number().min(0).max(1).optional(),
  /** BCP-47 language hint captured from the call. */
  language: z.string().optional(),
});

export type CreateCustomerVoiceMetadata = z.infer<
  typeof createCustomerVoiceMetadataSchema
>;

/**
 * Extended schema used by the voice task handler. Mirrors the base
 * `createCustomerPayloadSchema` and adds optional voice metadata so
 * the proposal-review UI can render the audio context. The base
 * schema is still the source of truth for `PROPOSAL_TYPE_SCHEMAS` —
 * this extension is for callers that explicitly opt into the richer
 * shape.
 */
export const createCustomerVoicePayloadSchema = createCustomerPayloadSchema.extend({
  voice: createCustomerVoiceMetadataSchema.optional(),
  /**
   * Operator-only opt-in flag controlling whether the new customer is
   * SMS-eligible by default. Deliberately defaults to FALSE per the
   * tenant SMS-consent rule — consent must be explicitly captured.
   */
  smsConsent: z.boolean().optional(),
});

export type CreateCustomerVoicePayload = z.infer<
  typeof createCustomerVoicePayloadSchema
>;

/**
 * Build a minimal payload from the fields the voice task extracts.
 * Ensures `name` is always present (voice flow guarantees this — the
 * task escalates instead of producing a nameless proposal). Drops
 * empty-string fields so the resulting object validates against the
 * base schema even when the LLM returned an empty `email`.
 */
export function buildCreateCustomerPayload(input: {
  name: string;
  email?: string;
  phone?: string;
  address?: string;
  notes?: string;
  voice?: CreateCustomerVoiceMetadata;
  smsConsent?: boolean;
}): CreateCustomerVoicePayload {
  const payload: CreateCustomerVoicePayload = {
    name: input.name,
  };
  if (input.email && input.email.trim().length > 0) payload.email = input.email.trim();
  if (input.phone && input.phone.trim().length > 0) payload.phone = input.phone.trim();
  if (input.address && input.address.trim().length > 0) payload.address = input.address.trim();
  if (input.notes && input.notes.trim().length > 0) payload.notes = input.notes.trim();
  if (input.voice) payload.voice = input.voice;
  if (typeof input.smsConsent === 'boolean') payload.smsConsent = input.smsConsent;
  return payload;
}
