/**
 * #846 / D-027 — content builder for the live-call complaint follow-up.
 *
 * A complaint heard on a live call ESCALATES to a human (the FSM's complaint
 * global guard fast-paths to `escalating`, like operator_request); the
 * `callback` proposal built here is the escalation's PAPER TRAIL, minted
 * one-shot by the voice-turn processor. Same precedent as
 * `buildNegotiationCallbackContent` one file over: the guardrail's payload /
 * summary / explanation live in one builder so the processor branch stays a
 * thin caller and tests pin the content in one place.
 *
 * Severity is the SAME deterministic keyword detection the recorded-memo
 * path (`ComplaintTaskHandler`) uses, run over the caller's ACTUAL words —
 * `detectText` must include the raw utterance, not just whatever entities
 * the classifier extracted — so the review surfaces (cards, SMS render,
 * digest) flag both legs alike.
 *
 * Always a `callback` and never an `add_note`: `add_note` is operator-only
 * (not in S1_ALLOWED_PROPOSAL_TYPES), so on the untrusted live-caller
 * surface it would be coerced to a bare clarification — the exact silent
 * degrade #846 fixed.
 */
import {
  complaintSeverity,
  COMPLAINT_HIGH_SEVERITY_REASON,
} from '../../ai/tasks/complaint-task';

export interface BuildComplaintCallbackInput {
  /**
   * Everything severity detection should see: classifier-extracted
   * noteBody/transcript entities plus the caller's raw utterance.
   */
  detectText: string;
  customerName?: string;
  conversationId?: string;
}

export interface ComplaintCallbackContent {
  payload: Record<string, unknown>;
  summary: string;
  explanation: string;
  severity: 'high' | 'normal';
}

export function buildComplaintCallbackContent(
  input: BuildComplaintCallbackInput,
): ComplaintCallbackContent {
  const detectText = input.detectText.trim();
  const severity = complaintSeverity(detectText);
  const severityMeta =
    severity === 'high'
      ? {
          _meta: {
            // Required by the _meta contract; 'medium' is neutral (only
            // low/very_low gate anything). The marker is the payload.
            overallConfidence: 'medium',
            markers: [{ path: 'body', reason: COMPLAINT_HIGH_SEVERITY_REASON }],
          },
        }
      : {};
  const who = input.customerName ?? 'the customer';
  return {
    payload: {
      reason: 'customer_complaint_followup',
      transcript:
        detectText ||
        'Caller reported a complaint on a live call — no details were captured; check the call transcript.',
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      ...severityMeta,
    },
    summary:
      severity === 'high'
        ? `HIGH-SEVERITY complaint — call ${who} back`
        : `Complaint follow-up — call ${who} back`,
    explanation:
      'Heard on a live call; the caller was handed to a person (complaints escalate, D-027). This callback is the owner follow-up paper trail — the transcript carries the details. No note is drafted on the live-caller surface (add_note is operator-only).',
    severity,
  };
}
