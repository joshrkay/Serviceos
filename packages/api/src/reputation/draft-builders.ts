/**
 * P7-026 — Public + private response draft builders.
 *
 * Both builders route through the LLM gateway per CLAUDE.md
 * ("All AI calls: route through LLM gateway"). They are pure
 * functions over (review, tenantContext, classification, optional
 * matched-customer) — no I/O outside the gateway call.
 *
 * Public draft:
 *   - Generated, then passed through `pii-redactor.ts`'s
 *     `assertNoPiiInPublicDraft` as a non-negotiable final pass.
 *   - On classification === 'wrong_business', the builder SHORT-CIRCUITS
 *     and returns null (per the dispatch addendum: "A review tagged
 *     `wrong_business` should not generate a public response at all").
 *
 * Private draft:
 *   - Only generated when the customer match is high-confidence.
 *   - Carries customer-identifying detail (first name only by
 *     convention; backend has the rest if needed); the PII redactor
 *     does NOT run on private messages because the customer's own
 *     contact info is appropriate context for an apology SMS/email.
 *
 * Brand voice (P4-015):
 *   - The story says the public draft should use the locked brand voice.
 *     At the time PR-c is written, no brand-voice module exists under
 *     packages/api/src/ai/. We use a minimal voice template and stamp a
 *     TODO(P4-015) marker so the gap is visible. The PR description
 *     calls this out per the dispatch addendum's pre-flight note.
 */

import { LLMGateway } from '../ai/gateway/gateway';
import { assertNoPiiInPublicDraft } from './pii-redactor';
import type {
  GoogleReview,
  ReviewClassification,
} from './types';

export interface TenantBrandContext {
  /** Human-readable business name used in greetings ("Fieldly HVAC"). */
  businessName: string;
  /** Owner display name used to sign the message ("— Mike, Owner"). */
  ownerDisplayName?: string;
  /**
   * Optional voice-template override. When unset, the default
   * apology-tone template is used (see `defaultVoiceTemplate` below).
   */
  // TODO(P4-015): wire the locked brand-voice module under
  // packages/api/src/ai/** so the prompt below can pull from it instead
  // of falling back to the default template.
  brandVoiceTemplate?: string;
}

export interface MatchedCustomerContext {
  customerId: string;
  firstName: string;
  /**
   * Last name carried through so the PII redactor knows what to strip
   * from the public draft. NEVER inlined into the public prompt itself
   * — keeping it here defends against an LLM that picks it up "from
   * context".
   */
  lastName: string;
}

export interface BuildPublicDraftInput {
  tenantId: string;
  review: Pick<GoogleReview, 'rating' | 'commentText' | 'reviewerName' | 'classification'>;
  brand: TenantBrandContext;
  matched?: MatchedCustomerContext;
  gateway: LLMGateway;
}

export interface BuildPrivateDraftInput {
  tenantId: string;
  review: Pick<GoogleReview, 'rating' | 'commentText' | 'reviewerName'>;
  brand: TenantBrandContext;
  matched: MatchedCustomerContext;
  gateway: LLMGateway;
}

export interface PublicDraft {
  text: string;
  /** Empty when no redactions were necessary. */
  redactedPii: ReadonlyArray<{ type: string; original: string }>;
}

export interface PrivateDraft {
  text: string;
  channel: 'sms' | 'email';
}

const DEFAULT_BRAND_VOICE_TEMPLATE = `
Tone: warm, accountable, conversational. American small-business voice.
Length: 2-4 sentences. No corporate-speak. No emojis. No legalese.
Format: acknowledge, take responsibility, invite an offline follow-up.
Never include any contact details inside the response itself — the
follow-up channel is a private message we send separately.
`.trim();

/**
 * Build the public Google response. Returns null on a wrong_business
 * classification (short-circuit per spec). Always passes the LLM output
 * through the PII redactor as a final assertion before returning.
 */
export async function buildPublicDraft(
  input: BuildPublicDraftInput,
): Promise<PublicDraft | null> {
  if (input.review.classification === 'wrong_business') {
    return null;
  }

  const voice = input.brand.brandVoiceTemplate ?? DEFAULT_BRAND_VOICE_TEMPLATE;

  const prompt = `${voice}

You are drafting a public reply to a Google review for ${input.brand.businessName}.

Review (rating ${input.review.rating}/5):
${JSON.stringify((input.review.commentText ?? '').slice(0, 2000))}

Reviewer's displayed name: ${input.review.reviewerName}

Constraints:
- The reply will be POSTED PUBLICLY on Google for anyone to read.
- Do NOT include the customer's address, phone number, email, last name, or any internal IDs.
- Do NOT mention internal staff last names.
- Refer to the customer by first name ONLY if at all.
- Keep it 2-4 sentences.

Return ONLY the reply text, no markdown, no quotes.`;

  let raw: string;
  try {
    const response = await input.gateway.complete({
      taskType: 'review_public_response',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.4,
      maxTokens: 300,
      metadata: { tenantId: input.tenantId, skill: 'public_review_response' },
    });
    raw = (response.content ?? '').trim();
  } catch {
    raw = stubPublicResponse(input);
  }

  if (!raw) raw = stubPublicResponse(input);

  // PII redaction is non-negotiable. Per the risk note: this is the
  // single highest-failure-mode in the story. The redactor is the last
  // pass; if anything slipped through the prompt, this catches it.
  const disallowedLastNames = input.matched ? [input.matched.lastName] : [];
  const { redactPublicDraft } = await import('./pii-redactor');
  const { redacted, redactions } = redactPublicDraft({
    text: raw,
    disallowedLastNames,
  });

  // Belt-and-suspenders: the redactor itself never leaks PII back,
  // and the strict assertion ensures any future regex change can't
  // silently let PII through.
  assertNoPiiInPublicDraft({
    text: redacted,
    disallowedLastNames,
  });

  return { text: redacted, redactedPii: redactions };
}

/**
 * Build the private (SMS or email) apology message. Customer matching
 * MUST already be 'high' confidence — the caller is responsible for
 * not calling this when matchConfidence is anything else.
 */
export async function buildPrivateDraft(
  input: BuildPrivateDraftInput,
): Promise<PrivateDraft> {
  const voice = input.brand.brandVoiceTemplate ?? DEFAULT_BRAND_VOICE_TEMPLATE;
  const prompt = `${voice}

You are drafting a PRIVATE SMS apology from ${input.brand.businessName} to ${input.matched.firstName}.
This message is delivered directly to the customer (NOT posted publicly).

Recent review (rating ${input.review.rating}/5):
${JSON.stringify((input.review.commentText ?? '').slice(0, 2000))}

Constraints:
- 1-2 sentences max, SMS-friendly length (under 320 chars).
- Acknowledge the specific issue if one is named.
- Offer to make it right; do NOT promise a credit (the owner will).
- Sign off as the owner if a name is provided, otherwise as the business.

Return ONLY the message text, no markdown.`;

  let raw: string;
  try {
    const response = await input.gateway.complete({
      taskType: 'review_private_apology',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.4,
      maxTokens: 200,
      metadata: { tenantId: input.tenantId, skill: 'private_review_apology' },
    });
    raw = (response.content ?? '').trim();
  } catch {
    raw = stubPrivateApology(input);
  }
  if (!raw) raw = stubPrivateApology(input);
  return { text: raw, channel: 'sms' };
}

function stubPublicResponse(input: BuildPublicDraftInput): string {
  // TODO(P4-015): replace with brand-voice-driven generation. Stub
  // returns a minimal apology used only when the LLM gateway is
  // unavailable; the redactor still runs on it.
  return `We're sorry to hear about your experience and we'd like to make it right. Please reach out so we can follow up. — ${input.brand.ownerDisplayName ?? input.brand.businessName}`;
}

function stubPrivateApology(input: BuildPrivateDraftInput): string {
  return `Hi ${input.matched.firstName}, this is ${input.brand.ownerDisplayName ?? input.brand.businessName}. We saw your review and want to make this right. Can we connect?`;
}
