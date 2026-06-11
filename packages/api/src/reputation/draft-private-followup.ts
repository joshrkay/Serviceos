/**
 * P7-026 PR c — Private follow-up draft composer.
 *
 * Produces a 1:1 message (email or SMS) addressed to the matched
 * customer behind a Google review. ONLY runs when the matcher
 * returned a confident `MatchedCustomer` — null match → no private
 * draft.
 *
 * Channel choice: this composer accepts the channel as input. The
 * caller (`build-proposal.ts`) decides channel based on the
 * customer's `preferredChannel` field (or defaults to email when
 * unknown — email tolerates longer bodies and has fewer regulatory
 * implications than SMS).
 *
 * PII redaction:
 *   - INPUT: review comment redacted before the LLM sees it.
 *   - OUTPUT: response redacted, BUT we pass
 *     `preserveKnownFirstNames: [matched.firstName]` so the customer's
 *     own first name stays visible in "Hi Alice, ..." salutations.
 *     The redactor still strips other names, emails, phones, addresses.
 */

import { LLMGateway } from '../ai/gateway/gateway';
import { BrandVoice } from './brand-voice';
import { Classification } from './classifier';
import { MatchedCustomer } from './match-customer';
import { redactPii } from './pii-redact';
import { Review } from './review';

import type { PrivateFollowUpChannel } from '@ai-service-os/shared';

export const REVIEW_PRIVATE_FOLLOWUP_TASK_TYPE = 'review_private_followup';

export interface DraftPrivateFollowUpInput {
  review: Review;
  classification: Classification;
  brandVoice: BrandVoice;
  matchedCustomer: MatchedCustomer;
  channel: PrivateFollowUpChannel;
}

export interface DraftPrivateFollowUpDeps {
  llmGateway: LLMGateway;
}

const CLASSIFICATION_GUIDANCE: Record<Classification, string> = {
  praise:
    'The review is positive. Send a warm personal thank-you. Mention that the team appreciated reading the review. Keep it under 4 sentences.',
  specific_complaint:
    'The review names a specific grievance. Apologize directly, acknowledge what went wrong (paraphrased — do not re-quote the harshest words), and offer concrete next steps to make it right (a callback, a return visit, etc.). Keep it under 6 sentences.',
  vague_complaint:
    'The review is critical but lacks specifics. Apologize that the experience fell short and politely ask what specifically went wrong so the team can address it. Keep it under 5 sentences.',
};

function buildSystemPrompt(brandVoice: BrandVoice, channel: PrivateFollowUpChannel): string {
  const channelGuidance =
    channel === 'sms'
      ? 'This will be sent as SMS — keep the body under 320 characters total. No subject line.'
      : 'This will be sent as email — slightly longer is fine. Do not include a "Subject:" line; the system will add one.';

  const lines: string[] = [
    'You draft private 1:1 messages from a home-services business owner to a customer who recently left a Google review.',
    'The customer\'s identity is known. Address them by first name in a natural salutation.',
    'Never include other personal contact details (other phone numbers, other email addresses, third-party last names, street addresses) in the message.',
    'Return ONLY the message body, no quotes, no commentary, no metadata.',
    channelGuidance,
  ];
  if (brandVoice.tone) {
    lines.push(`Tone guidance: ${brandVoice.tone}`);
  }
  if (brandVoice.signoff) {
    lines.push(`End the message with this signoff verbatim: ${brandVoice.signoff}`);
  }
  return lines.join('\n');
}

function buildUserPrompt(
  redactedComment: string,
  rating: number,
  classification: Classification,
  customerFirstName: string,
): string {
  return [
    `Customer first name: ${customerFirstName}`,
    `Star rating: ${rating}`,
    `Review classification: ${classification}`,
    `Guidance: ${CLASSIFICATION_GUIDANCE[classification]}`,
    `<comment>${redactedComment}</comment>`,
    '',
    'Draft the private message now.',
  ].join('\n');
}

/**
 * Compose a private-message draft addressed to the matched customer.
 * Returns the body text; the caller wraps it with channel metadata
 * (email subject, SMS to-number) when assembling the proposal.
 */
export async function draftPrivateFollowUp(
  input: DraftPrivateFollowUpInput,
  deps: DraftPrivateFollowUpDeps,
): Promise<string> {
  const rawComment = (input.review.commentText ?? '').trim();
  const redactedComment = redactPii(rawComment, {
    // INPUT redaction allows the customer's first name through so the
    // model can reason about whether the review actually mentions
    // them (rare, but happens). Other PII is still scrubbed.
    preserveKnownFirstNames: [input.matchedCustomer.firstName],
  });

  const systemPrompt = buildSystemPrompt(input.brandVoice, input.channel);
  const userPrompt = buildUserPrompt(
    redactedComment,
    input.review.rating,
    input.classification,
    input.matchedCustomer.firstName,
  );

  const response = await deps.llmGateway.complete({
    taskType: REVIEW_PRIVATE_FOLLOWUP_TASK_TYPE,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    tenantId: input.review.tenantId,
  });

  // OUTPUT redaction. Keep the matched customer's first name visible
  // so "Hi Alice, ..." reads naturally; everything else stays
  // protected.
  const body = redactPii(response.content.trim(), {
    preserveKnownFirstNames: [input.matchedCustomer.firstName],
  });

  return body;
}
