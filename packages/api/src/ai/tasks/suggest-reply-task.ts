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
import { resolveRegister } from '../brand-voice/prompts';
import {
  buildStandingInstructionsSection,
  type InjectedStandingInstruction,
} from '../standing-instructions-context';
import { buildUntrustedContentSection } from '../untrusted-content';
import { classifyMessageProvenance } from '../content-provenance';

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
  /** Tenant that owns the conversation; routes AI-run logging/quota correctly. */
  tenantId?: string;
  /** Soft character cap for the draft (SMS-friendly default). */
  maxChars?: number;
  /**
   * UB-A3 — owner standing instructions applicable to this reply, resolved
   * best-effort by the route (never blocking the draft). Injected as a
   * delimited system-message section that adjusts CONTENT only. No applied-id
   * ask here: the task returns plain text, and an id list would corrupt it.
   */
  standingInstructions?: InjectedStandingInstruction[];
}

export interface SuggestReplyResult {
  draft: string;
}

const DEFAULT_MAX_CHARS = 320;
const MAX_THREAD_MESSAGES = 20;

/** Build the brand-voice system prompt from the tenant's settings. */
function buildSystemPrompt(input: SuggestReplyInput): string {
  const bv = input.brandVoice ?? {};
  const shop = bv.business_name || input.businessName || 'the business';
  const pronoun = bv.pronoun === 'i' ? 'I' : 'we';
  // N-011 — register is authoritative; legacy `formality` maps forward.
  const formality =
    resolveRegister(bv) === 'formal'
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

/**
 * RIVET I13 — partition the thread by provenance. Shop-authored lines are
 * TRUSTED context (fencing them would tell the model to distrust its own
 * shop's confirmed times and prices); only customer-authored lines belong
 * inside the untrusted fence. Each line carries its chronological turn
 * number `[n]` so the interleaved order survives the partition — without
 * it, "customer question → shop answer → customer correction" reads as
 * "shop answer → both customer turns" and the model replies to an
 * already-answered question or misattaches the correction.
 */
function buildThreadSections(messages: SuggestReplyMessage[]): {
  shopLines: string[];
  customerLines: string[];
} {
  const shopLines: string[] = [];
  const customerLines: string[] = [];
  const thread = messages
    .filter((x) => x.content && x.content.trim().length > 0)
    .slice(-MAX_THREAD_MESSAGES);
  thread.forEach((m, i) => {
    const turn = `[${i + 1}]`;
    if (classifyMessageProvenance(m) === 'untrusted') {
      customerLines.push(`${turn} Customer: ${m.content.trim()}`);
    } else {
      shopLines.push(`${turn} Shop: ${m.content.trim()}`);
    }
  });
  return { shopLines, customerLines };
}

export class SuggestReplyTask {
  readonly taskType = 'suggest_reply' as const;

  constructor(private readonly gateway: LLMGateway) {}

  async suggest(input: SuggestReplyInput): Promise<SuggestReplyResult> {
    const { shopLines, customerLines } = buildThreadSections(input.messages);
    if (shopLines.length + customerLines.length === 0) {
      throw new Error('No conversation content to reply to');
    }

    // UB-A3 — standing instructions ride a separate, delimited system message
    // so the base prompt stays byte-identical when none apply.
    const systemMessages: Array<{ role: 'system'; content: string }> = [
      { role: 'system', content: buildSystemPrompt(input) },
    ];
    if (input.standingInstructions && input.standingInstructions.length > 0) {
      systemMessages.push({
        role: 'system',
        content: buildStandingInstructionsSection(input.standingInstructions, {
          requestAppliedIds: false,
        }),
      });
    }
    // RIVET I13 — ONLY the customer-authored lines ride inside the untrusted
    // fence; the shop's own prior messages are trusted context (fencing them
    // would tell the model to distrust the shop's confirmed times/prices).
    // Everything stays in the LOWEST-authority slot — the user message, never
    // a system message, whose higher instruction priority is the very thing
    // the fence exists to deny caller text. A "Customer:" line that says
    // "ignore previous instructions" is quoted DATA to reply to.
    const userSections: string[] = [];
    if (shopLines.length > 0) {
      userSections.push(`The shop's own messages in this conversation:\n${shopLines.join('\n')}`);
    }
    if (customerLines.length > 0) {
      userSections.push(
        buildUntrustedContentSection(customerLines.join('\n'), 'Customer message thread'),
      );
    }
    userSections.push(
      "Turn numbers [n] give the chronological order of the conversation across both sections above. Using that conversation, draft the shop's next reply.",
    );

    const response = await this.gateway.complete({
      taskType: this.taskType,
      ...(input.tenantId ? { tenantId: input.tenantId } : {}),
      messages: [
        ...systemMessages,
        {
          role: 'user',
          content: userSections.join('\n\n'),
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
