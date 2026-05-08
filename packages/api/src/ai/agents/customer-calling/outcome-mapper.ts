import type { CallOutcome } from '../../../voice/voice-service';
import type { CallingAgentContext, CallingAgentState } from './types';

export interface DeriveOutcomeInput {
  finalState: CallingAgentState;
  endedReason: string;
  context: CallingAgentContext;
  transcript: ReadonlyArray<string>;
  proposalIds: ReadonlyArray<string>;
}

const ESCALATION_REASONS_HUMAN: ReadonlySet<string> = new Set([
  'cost_cap_exceeded',
  'caller_identification_failed',
  'caller_identity_unresolved',
  'low_confidence_intent',
  'entity_not_found',
  'emergency_dispatch',
]);

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

  if (finalState === 'escalating' || finalState === 'degraded') {
    if (context.escalationReason && context.escalationReason.startsWith('system_failure:')) {
      return 'failed';
    }
    if (hasProposal) return 'callback_required';
    if (context.escalationReason && ESCALATION_REASONS_HUMAN.has(context.escalationReason)) {
      return 'escalated_to_human';
    }
    return 'escalated_to_human';
  }

  if (endedReason === 'caller_hangup') {
    if (!spoke) return 'dropped';
    if (hasProposal) return 'completed';
    if (!intentSet) return 'no_intent';
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
