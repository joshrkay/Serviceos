/**
 * Suggest-reply task — drafts a brand-voiced reply to a customer conversation.
 *
 * The unified customer timeline (`customers/timeline.ts`) and conversation
 * threads already aggregate SMS / email / voice history, but the owner still
 * types every reply by hand. This task closes the AI-first gap that Jobber /
 * ServiceTitan's "suggested replies" cover: given the recent thread and the
 * tenant's brand voice, it returns ONE concise draft.
 *
 * It is a *draft only* — the route returns it for the owner to edit and send,
 * consistent with the product's never-auto-send trust model. No proposal, no
 * mutation, no outbound message is created here.
 */
import { LLMGateway } from '../gateway/gateway';
import type { BrandVoiceSettings } from '../../settings/settings';

/** A thread message, trimmed to what the prompt needs. */
export interface SuggestReplyMessage {
  /** Who wrote it. 'customer' is the inbound side; anything else is the shop. */
  senderRole: string;
  content: string;
}

export interface SuggestReplyInput {
  messages: SuggestReplyMessage[];
  brandVoice?: BrandVoiceSettings | null;
  businessName?: string;
  /** Soft character cap for the draft (SMS-friendly default). */
  maxChars?: number;
}

export interface SuggestReplyResult {
  draft: string;
}

const DEFAULT_MAX_CHARS = 320;
const MAX_THREAD_MESSAGES = 20;

function isCustomer(senderRole: string): boolean {
  return senderRole.trim().toLowerCase() === 'customer';
}

/** Build the brand-voice system prompt from the tenant's settings. */
function buildSystemPrompt(input: SuggestReplyInput): string {
  const bv = input.brandVoice ?? {};
  const shop = bv.business_name || input.businessName || 'the business';
  const pronoun = bv.pronoun === 'i' ? 'I' : 'we';
  const formality =
    bv.formality === 'professional'
      ? 'professional and polished'
      : 'warm, friendly, and plain-spoken';
  const vibe =
    bv.vibe_words && bv.vibe_words.length > 0
      ? ` Lean into this character: ${bv.vibe_words.join(', ')}.`
      : '';

  return [
    `You are the office assistant for ${shop}, a home-services business, drafting a reply to a customer message.`,
    `Write in the first person as the shop, using "${pronoun}". Tone: ${formality}.${vibe}`,
    `Rules:`,
    `- Reply to the customer's most recent message and move the conversation forward.`,
    `- Be specific and helpful, but NEVER promise a price, discount, or exact arrival time the shop hasn't confirmed — offer to confirm instead.`,
    `- Do not invent facts (appointment times, totals, names) that aren't in the thread.`,
    `- Keep it to ${input.maxChars ?? DEFAULT_MAX_CHARS} characters or fewer when possible.`,
    `Return ONLY the reply text — no preamble, quotes, or signature.`,
  ].join('\n');
}

function buildTranscript(messages: SuggestReplyMessage[]): string {
  return messages
    .filter((m) => m.content && m.content.trim().length > 0)
    .slice(-MAX_THREAD_MESSAGES)
    .map((m) => `${isCustomer(m.senderRole) ? 'Customer' : 'Shop'}: ${m.content.trim()}`)
    .join('\n');
}

export class SuggestReplyTask {
  readonly taskType = 'suggest_reply' as const;

  constructor(private readonly gateway: LLMGateway) {}

  async suggest(input: SuggestReplyInput): Promise<SuggestReplyResult> {
    const transcript = buildTranscript(input.messages);
    if (transcript.length === 0) {
      throw new Error('No conversation content to reply to');
    }

    const response = await this.gateway.complete({
      taskType: this.taskType,
      messages: [
        { role: 'system', content: buildSystemPrompt(input) },
        {
          role: 'user',
          content: `Here is the conversation so far:\n\n${transcript}\n\nDraft the shop's next reply.`,
        },
      ],
      temperature: 0.7,
      responseFormat: 'text',
    });

    // Strip stray wrapping quotes/whitespace a model sometimes adds.
    const draft = response.content.trim().replace(/^"(.*)"$/s, '$1').trim();
    if (!draft) {
      throw new Error('The assistant returned an empty draft');
    }
    return { draft };
  }
}
