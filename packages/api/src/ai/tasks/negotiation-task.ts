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
import { buildNegotiationCallbackContent } from '../../proposals/guardrails/negotiation-guardrail';
import type {
  CustomerNegotiationContext,
  CustomerNegotiationContextProvider,
} from '../../customers/customer-negotiation-context';

export class NegotiationGuardrailTaskHandler implements TaskHandler {
  // Reuses the capture-class `callback` proposal type. processSegment resolves
  // this handler by intent name ('negotiation'), not by proposal type, so the
  // taskType is just the proposal it emits.
  readonly taskType: ProposalType = 'callback';

  constructor(private readonly contextProvider?: CustomerNegotiationContextProvider) {}

  async handle(context: TaskContext): Promise<TaskResult> {
    const ee = (context.existingEntities ?? {}) as ExtractedEntities & {
      customerId?: string;
      negotiationAsk?: string;
    };
    // Enrich the owner callback with the caller's LTV/recency when we resolved a
    // customer. Best-effort: a read failure never blocks the guardrail callback.
    let customerContext: CustomerNegotiationContext | null = null;
    if (ee.customerId && this.contextProvider) {
      try {
        customerContext = await this.contextProvider.getContext(context.tenantId, ee.customerId);
      } catch {
        customerContext = null;
      }
    }
    const content = buildNegotiationCallbackContent({
      detectText: context.message,
      askText: ee.negotiationAsk ?? context.message,
      ...(ee.customerName ? { customerName: ee.customerName } : {}),
      transcript: context.message,
      ...(context.conversationId ? { conversationId: context.conversationId } : {}),
      customerContext,
    });

    // Deterministic dedup so at-least-once redelivery of the same recording
    // never double-creates the callback (parity with complaint-task).
    const idempotencyKey = context.recordingId
      ? `voice-negotiation-callback:${context.recordingId}`
      : undefined;

    const proposal = createProposal({
      tenantId: context.tenantId,
      proposalType: 'callback',
      payload: content.payload,
      summary: content.summary,
      explanation: content.explanation,
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
