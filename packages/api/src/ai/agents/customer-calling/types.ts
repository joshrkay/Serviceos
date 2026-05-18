/**
 * Customer Calling Agent — Types
 *
 * All types used by the channel-agnostic state machine. No I/O here;
 * all side effects are returned as data and executed by callers/adapters.
 */

import type { RepairTemplate } from '../../../verticals/registry';
import type { EscalationSummary } from './escalation-summary-builder';

// ─── States ──────────────────────────────────────────────────────────────────

export type CallingAgentState =
  | 'idle'
  | 'greeting'
  | 'identifying'
  | 'ask_caller'
  | 'intent_capture'
  | 'entity_resolution'
  | 'intent_confirm'
  | 'proposal_draft'
  | 'closing'
  | 'escalating'
  | 'degraded'
  | 'terminated';

// ─── Channel ─────────────────────────────────────────────────────────────────

export type CallingAgentChannel = 'telephony' | 'inapp';

// ─── Events ──────────────────────────────────────────────────────────────────

export type CallingAgentEvent =
  // Telephony adapter events (Twilio webhook → internal adapter → state machine)
  | { type: 'incoming_call'; callSid: string; from: string; to: string; tenantId: string }
  | { type: 'audio_chunk_received'; audioBlob: Buffer; ts: number }
  | { type: 'dtmf_received'; digit: string; ts: number }
  | { type: 'silence_timeout'; msSilent: number }
  | { type: 'caller_hangup' }
  | { type: 'call_status_updated'; status: string }
  | { type: 'recording_completed'; recordingUrl: string }
  // In-app voice adapter events (frontend AssistantPage / VoiceUpdatePage → API)
  | { type: 'session_started'; userId: string; tenantId: string; conversationId: string }
  | { type: 'text_input'; text: string }
  | { type: 'session_ended' }
  // Internal events (produced by skills, consumed by the state machine)
  | { type: 'intent_classified'; intentType: string; entities: Record<string, unknown>; confidence: number }
  | { type: 'entity_resolved'; refs: Record<string, string> }
  | { type: 'entity_ambiguous'; candidates: Array<{ id: string; name: string; score: number }> }
  | { type: 'entity_not_found' }
  | { type: 'confidence_low'; threshold: number; score: number }
  | { type: 'proposal_queued'; proposalId: string }
  | { type: 'cost_cap_approached'; remainingPct: number }
  | { type: 'cost_cap_exceeded' }
  | { type: 'abuse_detected'; category: string }
  | { type: 'prompt_injection_detected' }
  | { type: 'compliance_violation_detected'; rule: string }
  | { type: 'greeted_ok' }
  | { type: 'caller_known'; customerId: string }
  | { type: 'unknown_caller' }
  | { type: 'caller_identification_failed'; reason: string }
  | { type: 'system_failure'; reason: string }
  | { type: 'confirmed' }
  | { type: 'correction'; newTranscript: string }
  | { type: 'closed' }
  | { type: 'second_intent' }
  | { type: 'frustration_detected'; source: 'keyword' | 'llm_sentiment'; detail?: string };

// ─── Context ─────────────────────────────────────────────────────────────────

export interface CallingAgentContext {
  sessionId: string;
  tenantId: string;
  channel: CallingAgentChannel;
  callSid?: string;           // telephony only
  conversationId?: string;    // in-app only
  customerId?: string;        // set after identifying
  customerName?: string;
  currentIntent?: string;
  extractedEntities?: Record<string, unknown>;
  pendingProposalId?: string;
  retryCount: number;
  /**
   * Per-session reprompt counter for empty / low-confidence Gather turns
   * (telephony) and confidence_low events (in-app). Independent of
   * retryCount, which is scoped to ask_caller / intent_capture
   * substates. Bounded by MAX_REPROMPTS in transitions.ts.
   */
  repromptCount: number;
  escalationReason?: string;
  startedAt: number; // Date.now()
  /**
   * §P2-3 — Vertical-specific repair templates, sourced from the rich
   * pack at FSM construction time. Optional: when absent, the FSM falls
   * back to the generic "say that again" reprompt.
   */
  repairTemplates?: ReadonlyArray<RepairTemplate>;
}

// ─── Side effects ─────────────────────────────────────────────────────────────

export type SideEffectType =
  | 'tts_play'
  | 'audit_log'
  | 'create_proposal'
  | 'notify_oncall'
  | 'start_transcription'
  | 'end_session'
  | 'emit_quality_event'
  | 'escalate_with_context';

export interface SideEffect {
  type: SideEffectType;
  payload: Record<string, unknown>;
}

export interface EscalateWithContextPayload {
  escalationId: string;
  summary: EscalationSummary;
  dispatcher: { userId: string; phone: string };
  callSid: string;
  tenantId: string;
  channelPreferences: { sms: boolean; in_app: boolean; whisper: boolean };
}

// ─── Transition result ────────────────────────────────────────────────────────

export interface TransitionResult {
  nextState: CallingAgentState;
  sideEffects: SideEffect[];
  updatedContext: CallingAgentContext;
}
