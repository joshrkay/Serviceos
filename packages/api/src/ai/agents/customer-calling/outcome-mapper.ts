import type { CallOutcome } from '../../../voice/voice-service';
import type { CallingAgentContext, CallingAgentState } from './types';

export interface DeriveOutcomeInput {
  finalState: CallingAgentState;
  endedReason: string;
  context: CallingAgentContext;
  transcript: ReadonlyArray<string>;
  proposalIds: ReadonlyArray<string>;
}

function callerSpoke(transcript: ReadonlyArray<string>): boolean {
  return transcript.some((line) => line.toLowerCase().startsWith('caller:'));
}

export function deriveCallOutcome(input: DeriveOutcomeInput): CallOutcome {
  const { finalState, endedReason, context, transcript, proposalIds } = input;
  const spoke = callerSpoke(transcript);
  const intentSet = context.currentIntent !== undefined;
  const hasProposal = proposalIds.length > 0;

  if (endedReason.startsWith('abuse_detected:')) {
    return 'escalated_to_human';
  }

  // Transport-layer failures emitted by the mediastream adapter
  // (ws_error / ws_closed-before-stop / slow_consumer / queue_overflow).
  // Stamping these as 'failed' keeps voice_sessions.outcome analytics
  // honest — otherwise infra regressions hide as caller abandonment.
  if (endedReason === 'transport_failure') {
    return 'failed';
  }

  // Successful dispatcher transfer: the /dial-result route stamps this
  // when DialCallStatus=completed/answered. The call IS resolved (a
  // human answered), but no real proposal_id was persisted so the
  // generic hasProposal/intent heuristics below would mis-classify as
  // 'dropped'. An explicit reason short-circuits that.
  if (endedReason === 'transferred') {
    return 'completed';
  }

  if (finalState === 'escalating' || finalState === 'degraded') {
    if (context.escalationReason?.startsWith('system_failure:')) {
      return 'failed';
    }
    if (hasProposal) return 'callback_required';
    return 'escalated_to_human';
  }

  if (endedReason === 'caller_hangup') {
    if (!spoke) return 'dropped';
    if (hasProposal) return 'completed';
    return 'no_intent';
  }

  if (
    endedReason === 'normal_close' ||
    endedReason === 'closed' ||
    endedReason === 'session_ended' ||
    endedReason === 'manual_end' ||
    endedReason === 'idle_timeout'
  ) {
    if (hasProposal) return 'completed';
    if (intentSet) return 'completed';
    if (spoke) return 'no_intent';
    return 'dropped';
  }

  return 'failed';
}
