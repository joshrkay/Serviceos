import { z } from 'zod';

/**
 * send_customer_message proposal payload (Tradesperson wave 1, Task 5).
 *
 * A free-form outbound customer message ("Text the Hendersons the part
 * arrived", "Email the Garcias that the inspection passed"). Comms-class
 * (proposal.ts actionClassForProposalType) — always drafted, never
 * auto-approved (D3), per CLAUDE.md "Never auto-execute": the AI drafts
 * the exact text, the owner ALWAYS reads it before a customer sees it.
 *
 * `customerId` is a resolved, verified UUID — the spoken customer
 * reference is resolved to it BEFORE this payload is built
 * (`ai/agents/customer-calling/entity-resolution.ts` CUSTOMER_REF_INTENTS
 * membership, the SAME resolution ladder `update_customer` uses). There is
 * deliberately no free-text "customerReference" fallback field: an
 * unresolved reference gates the proposal (`missingFields: ['customerId']`)
 * rather than persisting a stand-in name for a later step to puzzle out —
 * same safer posture `record_refund`/`apply_credit` chose over
 * `record_payment`'s own precedent.
 *
 * `channel` defaults to 'sms' downstream when unstated (see
 * SendCustomerMessageTaskHandler) — the contract itself requires it
 * explicitly so a proposal can never execute with an ambiguous channel.
 *
 * `subject` is optional and only meaningful on the email channel. There is
 * deliberately NO `.refine()` forbidding it on `channel: 'sms'`: a stray
 * subject supplied alongside an SMS send is simply ignored by the delivery
 * adapter (TwilioCustomerMessageService only reads `subject` on the email
 * branch) — it is never surfaced to the customer, so rejecting it here
 * would be a needless extra failure mode with no user-facing benefit.
 *
 * `body` is capped at `SEND_CUSTOMER_MESSAGE_BODY_MAX_LENGTH` (1000) —
 * generous for both SMS (well beyond a single segment, but this is a single
 * free-form message, not a multi-part campaign) and a short email — and
 * must be non-empty after trimming (a whitespace-only "message" is not
 * real content).
 *
 * Quality-review fix — `SendCustomerMessageTaskHandler` enforces the SAME
 * cap at DRAFT time (importing this constant, never a re-declared magic
 * number), so a proposal can never pass drafting only to fail this exact
 * Zod check at approval: an LLM rewrite exceeding the cap is discarded in
 * favor of the (already within-cap, spoken) text, and whichever text is
 * finally chosen is truncated to `SEND_CUSTOMER_MESSAGE_BODY_MAX_LENGTH - 3`
 * characters plus "…" if it STILL exceeds the cap (covers a raw spoken
 * transcript alone running long, with no LLM rewrite involved at all). The
 * approval card must always show exactly what will send — WYSIWYG beats a
 * post-approval validation error.
 */
export const SEND_CUSTOMER_MESSAGE_CHANNELS = ['sms', 'email'] as const;
export type SendCustomerMessageChannel = (typeof SEND_CUSTOMER_MESSAGE_CHANNELS)[number];

export const SEND_CUSTOMER_MESSAGE_BODY_MAX_LENGTH = 1000;

export const sendCustomerMessagePayloadSchema = z.object({
  customerId: z.string().uuid(),
  channel: z.enum(SEND_CUSTOMER_MESSAGE_CHANNELS),
  body: z.string().trim().min(1).max(SEND_CUSTOMER_MESSAGE_BODY_MAX_LENGTH),
  subject: z.string().trim().min(1).max(200).optional(),
});

export type SendCustomerMessagePayload = z.infer<typeof sendCustomerMessagePayloadSchema>;
