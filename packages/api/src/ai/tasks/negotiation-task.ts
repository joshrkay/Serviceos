/**
 * N-003 (P2-036) — negotiation guardrail task handler.
 *
 * Mirrors ComplaintTaskHandler (src/ai/tasks/complaint-task.ts). When the
 * intent classifier flags a `negotiation` intent (a customer pushing on price,
 * scope, or terms), the AI must not answer substantively. This handler turns
 * that into a single owner-facing `callback` proposal carrying the customer's
 * ask, the detected ask type, and a deterministic recommendation. The callback
 * is capture-class, so it lands in 'draft' and never auto-executes — the owner
 * decides on their terms and follows up.
 *
 * Reuses the existing `callback` proposal type (no new type, no migration),
 * exactly like the complaint handler reuses `callback` for owner follow-up.
 * Registered under the synthetic '_negotiation' key in the voice-action-router
 * (resolved by intent name, not proposal type).
 */
import { createProposal } from '../../proposals/proposal';
import type { ProposalType } from '../../proposals/proposal';
import type { TaskHandler, TaskContext, TaskResult } from './task-handlers';
import type { ExtractedEntities } from '../orchestration/intent-classifier';
import {
  detectNegotiationAskType,
  negotiationAskLabel,
  recommendNegotiationResponse,
  NEGOTIATION_GUARDRAIL_MARKER_REASON,
} from '../../proposals/guardrails/negotiation-guardrail';

function capitalize(s: string): string {
  return s.length === 0 ? s : `${s.charAt(0).toUpperCase()}${s.slice(1)}`;
}

export class NegotiationGuardrailTaskHandler implements TaskHandler {
  // Reuses the capture-class `callback` proposal type. processSegment resolves
  // this handler by intent name ('negotiation'), not by proposal type, so the
  // taskType is just the proposal it emits.
  readonly taskType: ProposalType = 'callback';

  async handle(context: TaskContext): Promise<TaskResult> {
    const ee = (context.existingEntities ?? {}) as ExtractedEntities & {
      customerId?: string;
      negotiationAsk?: string;
    };
    const askText = (ee.negotiationAsk ?? context.message).trim();
    const askType = detectNegotiationAskType(`${context.message} ${askText}`);
    const label = negotiationAskLabel(askType);
    const recommendation = recommendNegotiationResponse(askType);
    const who = ee.customerName ?? 'the customer';

    // Deterministic dedup so at-least-once redelivery of the same recording
    // never double-creates the callback (parity with complaint-task).
    const idempotencyKey = context.recordingId
      ? `voice-negotiation-callback:${context.recordingId}`
      : undefined;

    const proposal = createProposal({
      tenantId: context.tenantId,
      proposalType: 'callback',
      payload: {
        reason: 'customer_negotiation_followup',
        negotiationAskType: askType ?? 'general',
        askText,
        recommendation,
        transcript: context.message,
        ...(context.conversationId ? { conversationId: context.conversationId } : {}),
        _meta: {
          // 'medium' is neutral (only low/very_low gate auto-approval); the
          // marker is the payload — it makes every review surface (cards, SMS
          // render, digest) flag that the guardrail fired.
          overallConfidence: 'medium',
          markers: [{ path: 'recommendation', reason: NEGOTIATION_GUARDRAIL_MARKER_REASON }],
        },
      },
      summary: `${capitalize(label)} from ${who} — AI didn't negotiate; call back`,
      explanation:
        'The AI detected price/scope/terms pushback, declined to negotiate, and indicated it would check with you. Decide on your terms and follow up.',
      sourceContext: {
        source: 'voice',
        ...(context.conversationId ? { conversationId: context.conversationId } : {}),
        ...(context.recordingId ? { recordingId: context.recordingId } : {}),
      },
      createdBy: context.userId,
      ...(idempotencyKey ? { idempotencyKey } : {}),
      ...(context.tenantThresholdOverride
        ? { tenantThresholdOverride: context.tenantThresholdOverride }
        : {}),
    });

    return { proposal, taskType: 'callback' };
  }
}
