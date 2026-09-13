/**
 * Tradesperson wave 1, Task 5 — SendCustomerMessageTaskHandler (drafting leg).
 *
 * Standalone file per the quality-review ratchet (mirrors complaint-task.ts /
 * brand-voice-task.ts / apply-credit-task.ts) — voice-extended-tasks.ts stays
 * untouched; new drafting handlers land in their own file.
 *
 * `send_customer_message` is a free-form outbound customer message ("Text
 * the Hendersons the part arrived", "Email the Garcias that the inspection
 * passed") — a NEW comms-class proposal type. Never auto-approves at any
 * trust tier (D3): the AI drafts the exact text, the owner ALWAYS approves
 * before a customer sees it.
 *
 * ── Customer resolution mirrors UpdateCustomerTaskHandler exactly ─────────
 *
 * `send_customer_message` joins `CUSTOMER_REF_INTENTS`
 * (ai/agents/customer-calling/entity-resolution.ts), so the voice-action-
 * router resolves the spoken customer name to a verified id BEFORE this
 * handler runs (or short-circuits to a `voice_clarification` on an
 * ambiguous match, or leaves it absent on no match / nothing spoken) and
 * threads it onto `context.customerId` — the SAME router-injected seam
 * `UpdateCustomerTaskHandler` reads (caller-ID identity, when present,
 * wins over the resolver; see voice-action-router.ts's TaskContext
 * construction). An unresolved reference gates
 * `missingFields: ['customerId']` rather than persisting a free-text
 * stand-in — same deliberately safer posture `record_refund`/
 * `apply_credit` chose for their invoice reference.
 *
 * ── The message body: optional, degradable LLM cleanup pass ──────────────
 *
 * The classifier extracts the spoken message verbatim onto
 * `customerMessageBody`. This handler optionally runs ONE more LLM call to
 * clean it up into a short, polite customer message — mirroring
 * `SuggestReplyTask`'s house pattern for AI-drafted customer-facing text
 * (ai/tasks/suggest-reply-task.ts). The rewrite is degradable at every
 * step: no gateway wired, or the rewrite call throwing / returning empty
 * content, falls back to the verbatim spoken text. This never fabricates
 * content beyond what the operator said, and never blocks the draft on an
 * LLM outage — the owner still gets a proposal to review either way.
 *
 * ── Draft-time clamp (quality-review fix) ─────────────────────────────────
 *
 * The contract (`proposals/contracts/send-customer-message.ts`) caps `body`
 * at `SEND_CUSTOMER_MESSAGE_BODY_MAX_LENGTH` chars — without a matching
 * draft-time clamp, a proposal could draft ungated (`missingFields` only
 * checks presence, not length) and then fail Zod validation the first time
 * anyone tries to approve or edit it, well after the owner already read and
 * approved the card. Two rules, applied in order:
 *   1. An LLM rewrite that EXCEEDS the cap is discarded in favor of the
 *      spoken text — never silently truncated text the operator never
 *      reviewed at drafting time.
 *   2. Whichever text is finally chosen (rewritten or spoken) is truncated
 *      to `SEND_CUSTOMER_MESSAGE_BODY_MAX_LENGTH - 3` characters plus "…"
 *      if it STILL exceeds the cap — covers a long raw spoken transcript
 *      with no LLM rewrite involved at all (no gateway wired, or the
 *      rewrite itself fell back per rule 1).
 * The approval card must always show exactly what will send — WYSIWYG
 * beats a post-approval validation error.
 */
import { createProposal } from '../../proposals/proposal';
import type { TaskHandler, TaskContext, TaskResult } from './task-handlers';
import type { LLMGateway } from '../gateway/gateway';
import { SEND_CUSTOMER_MESSAGE_BODY_MAX_LENGTH } from '../../proposals/contracts/send-customer-message';
import { entitiesFrom, inputFor } from './task-input';

const REWRITE_SYSTEM_PROMPT =
  "Rewrite the operator's spoken message as a short, polite customer message. Do not add promises, prices, or times the operator did not say.";

/** Room for the trailing "…" when a clamped body is truncated. */
const TRUNCATED_BODY_LENGTH = SEND_CUSTOMER_MESSAGE_BODY_MAX_LENGTH - 3;

export class SendCustomerMessageTaskHandler implements TaskHandler {
  readonly taskType = 'send_customer_message' as const;

  constructor(private readonly gateway?: LLMGateway) {}

  async handle(context: TaskContext): Promise<TaskResult> {
    const ee = entitiesFrom(context);
    const payload: Record<string, unknown> = {};
    const missing: string[] = [];

    // Router-injected verified customer id (see class doc comment above).
    if (context.customerId) {
      payload.customerId = context.customerId;
    } else {
      missing.push('customerId');
    }

    // Defaults to sms when unstated — contract requires it explicitly so a
    // proposal can never execute with an ambiguous channel.
    payload.channel = ee.customerMessageChannel === 'email' ? 'email' : 'sms';

    const spoken =
      typeof ee.customerMessageBody === 'string' ? ee.customerMessageBody.trim() : '';
    if (spoken.length > 0) {
      payload.body = await this.resolveBody(spoken, context.tenantId);
    } else {
      missing.push('body');
    }

    return {
      proposal: createProposal(inputFor(context, this.taskType, payload, missing)),
      taskType: this.taskType,
    };
  }

  /**
   * Resolves the final draft body: attempts the optional LLM rewrite, then
   * applies the draft-time clamp (class doc comment "Draft-time clamp"
   * above). Never fabricates, never blocks, never drafts a body the
   * contract will reject on length.
   */
  private async resolveBody(spoken: string, tenantId?: string): Promise<string> {
    const rewritten = await this.rewrite(spoken, tenantId);
    // Rule 1 — an over-cap rewrite is discarded in favor of the spoken
    // text rather than kept (even truncated): the operator never reviewed
    // the rewrite's tail, only spoke the original.
    const chosen =
      rewritten !== undefined && rewritten.length <= SEND_CUSTOMER_MESSAGE_BODY_MAX_LENGTH
        ? rewritten
        : spoken;
    // Rule 2 — whichever text was chosen still gets a hard clamp: this is
    // what catches a long spoken transcript with no rewrite involved.
    return chosen.length > SEND_CUSTOMER_MESSAGE_BODY_MAX_LENGTH
      ? `${chosen.slice(0, TRUNCATED_BODY_LENGTH)}…`
      : chosen;
  }

  /**
   * Optional, degradable LLM cleanup pass — see class doc comment "The
   * message body" above. Returns `undefined` (never throws) when no
   * gateway is wired, the call fails, or the result is empty after
   * cleanup — `resolveBody` above is the only caller and treats
   * `undefined` as "fall back to the spoken text."
   */
  private async rewrite(spoken: string, tenantId?: string): Promise<string | undefined> {
    if (!this.gateway) return undefined;
    try {
      const response = await this.gateway.complete({
        taskType: this.taskType,
        ...(tenantId ? { tenantId } : {}),
        messages: [
          { role: 'system', content: REWRITE_SYSTEM_PROMPT },
          { role: 'user', content: spoken },
        ],
        temperature: 0.3,
        responseFormat: 'text',
      });
      // Strip stray wrapping quotes/whitespace a model sometimes adds
      // (mirrors SuggestReplyTask).
      const cleaned = response.content.trim().replace(/^"(.*)"$/s, '$1').trim();
      return cleaned.length > 0 ? cleaned : undefined;
    } catch {
      // Degrade — never fabricate, never block the draft on an LLM outage.
      return undefined;
    }
  }
}
