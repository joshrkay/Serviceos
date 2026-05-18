/**
 * P7-026 PR c — Public review response draft composer.
 *
 * Produces a public-facing draft reply to a Google review. The output
 * is owner-approved before posting — see PR c's execution handler —
 * but the LLM should still produce something publishable as-is for
 * the common case.
 *
 * Defense-in-depth on PII:
 *   1. INPUT redact:  `review.commentText` is passed through `redactPii`
 *      BEFORE the LLM sees it, so the prompt never carries the
 *      reviewer's personal data into the provider's context.
 *   2. OUTPUT redact: the LLM's response is passed through `redactPii`
 *      AGAIN before the draft is persisted, so any PII the model
 *      hallucinated or echoed slips through nothing.
 *
 * The public response intentionally does NOT preserve any first names:
 * a public reply addressing "Alice" by name is creepy when "Alice" is
 * a Google-handle pseudonym, and is redundant when "Alice" is real
 * because the review already shows her name. Public reply stays
 * generic ("Thank you for the kind words!"). The private follow-up
 * (separate composer) is where personalization happens.
 */

import { LLMGateway } from '../ai/gateway/gateway';
import { BrandVoice } from './brand-voice';
import { Classification } from './classifier';
import { redactPii } from './pii-redact';
import { Review } from './review';

export const REVIEW_PUBLIC_RESPONSE_TASK_TYPE = 'review_public_response';

export interface DraftPublicResponseInput {
  review: Review;
  classification: Classification;
  brandVoice: BrandVoice;
}

export interface DraftPublicResponseDeps {
  llmGateway: LLMGateway;
}

const CLASSIFICATION_GUIDANCE: Record<Classification, string> = {
  praise:
    'The review is positive. Write a warm, brief thank-you that mentions appreciation for the time spent leaving the review. Keep it under 3 sentences.',
  specific_complaint:
    'The review names a specific grievance. Acknowledge the issue without admitting legal fault, apologize sincerely, and invite the reviewer to contact the business directly to make it right. Do NOT name the issue verbatim if it could embarrass the reviewer further. Keep it under 4 sentences.',
  vague_complaint:
    'The review is critical but lacks specifics. Express that you take all feedback seriously, apologize that their experience fell short, and invite them to share details directly so the business can address it. Keep it under 3 sentences.',
};

function buildSystemPrompt(brandVoice: BrandVoice): string {
  const lines: string[] = [
    'You draft public replies to Google Business Profile reviews for a home-services business.',
    'These replies are visible to all future customers searching for the business. Write professionally.',
    'Never include personal contact details (phone numbers, email addresses, customer last names, street addresses) in the public reply.',
    'Never include the customer\'s first name — the reply is generic. The customer\'s name is already visible to readers via the review itself.',
    'Return ONLY the reply text, no quotes, no commentary, no metadata.',
  ];
  if (brandVoice.tone) {
    lines.push(`Tone guidance: ${brandVoice.tone}`);
  }
  if (brandVoice.signoff) {
    lines.push(`End the reply with this signoff verbatim: ${brandVoice.signoff}`);
  }
  return lines.join('\n');
}

function buildUserPrompt(
  redactedComment: string,
  rating: number,
  classification: Classification,
): string {
  return [
    `Star rating: ${rating}`,
    `Review classification: ${classification}`,
    `Guidance: ${CLASSIFICATION_GUIDANCE[classification]}`,
    `<comment>${redactedComment}</comment>`,
    '',
    'Draft the public reply now.',
  ].join('\n');
}

/**
 * Compose a public-facing reply draft. Returns the redacted draft text
 * (already safe to display + safe to POST to Google verbatim, modulo
 * the owner's edits at approval time).
 */
export async function draftPublicResponse(
  input: DraftPublicResponseInput,
  deps: DraftPublicResponseDeps,
): Promise<string> {
  const rawComment = (input.review.commentText ?? '').trim();
  // INPUT redaction. Strip PII before the model sees it so the
  // provider's context never holds raw personal data — even on a
  // request that would have stayed in our infrastructure had it not
  // gone to the LLM.
  const redactedComment = redactPii(rawComment);

  const systemPrompt = buildSystemPrompt(input.brandVoice);
  const userPrompt = buildUserPrompt(
    redactedComment,
    input.review.rating,
    input.classification,
  );

  const response = await deps.llmGateway.complete({
    taskType: REVIEW_PUBLIC_RESPONSE_TASK_TYPE,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    tenantId: input.review.tenantId,
  });

  // OUTPUT redaction. Defense in depth: even if the model leaked PII
  // through somehow (echoed a name, hallucinated an email), the
  // redactor catches it before the text reaches the owner-review
  // pane. `preserveKnownFirstNames` intentionally empty — the public
  // reply must NEVER address the customer by first name.
  const draft = redactPii(response.content.trim(), {
    preserveKnownFirstNames: [],
  });

  return draft;
}
