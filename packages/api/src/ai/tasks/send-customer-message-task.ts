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
 */
import { createProposal, CreateProposalInput } from '../../proposals/proposal';
import type { TaskHandler, TaskContext, TaskResult } from './task-handlers';
import type { ExtractedEntities } from '../orchestration/intent-classifier';
import type { LLMGateway } from '../gateway/gateway';

const REWRITE_SYSTEM_PROMPT =
  "Rewrite the operator's spoken message as a short, polite customer message. Do not add promises, prices, or times the operator did not say.";

export class SendCustomerMessageTaskHandler implements TaskHandler {
  readonly taskType = 'send_customer_message' as const;

  constructor(private readonly gateway?: LLMGateway) {}

  async handle(context: TaskContext): Promise<TaskResult> {
    const ee = (context.existingEntities ?? {}) as ExtractedEntities;
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

    const input: CreateProposalInput = {
      tenantId: context.tenantId,
      proposalType: this.taskType,
      payload,
      summary: context.message,
      sourceContext: context.conversationId
        ? { conversationId: context.conversationId }
        : undefined,
      createdBy: context.userId,
      missingFields: missing.length > 0 ? missing : undefined,
      ...(context.tenantThresholdOverride
        ? { tenantThresholdOverride: context.tenantThresholdOverride }
        : {}),
    };

    return { proposal: createProposal(input), taskType: this.taskType };
  }

  /**
   * Optional, degradable LLM cleanup pass — see class doc comment "The
   * message body" above. No gateway wired, or any failure/empty result
   * from the rewrite call, falls back to the verbatim spoken text.
   */
  private async resolveBody(spoken: string, tenantId?: string): Promise<string> {
    if (!this.gateway) return spoken;
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
      return cleaned.length > 0 ? cleaned : spoken;
    } catch {
      // Degrade — never fabricate, never block the draft on an LLM outage.
      return spoken;
    }
  }
}
