/**
 * Customer Calling Agent — Types
 *
 * All types used by the channel-agnostic state machine. No I/O here;
 * all side effects are returned as data and executed by callers/adapters.
 */

import { z } from 'zod';
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
  | { type: 'intent_classified'; intentType: string; entities: Record<string, unknown>; confidence: number; aiRunId?: string }
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
  | {
      type: 'frustration_detected';
      source: 'keyword' | 'llm_sentiment';
      detail?: string;
      reasonHint?: string;
    }
  /**
   * RV-140 — deterministic emergency keyword hit on a transcript chunk
   * (emergency-detector.ts), dispatched BEFORE any LLM call. Global guard:
   * fast-paths to `escalating` from any non-terminal state with the 911
   * safety script (RV-142) spoken first, an emergency_dispatch proposal
   * queued, and the on-call transfer initiated.
   */
  | { type: 'emergency_detected'; keyword: string; utterance: string };

// ─── Context ─────────────────────────────────────────────────────────────────

export interface CallingAgentContext {
  sessionId: string;
  tenantId: string;
  channel: CallingAgentChannel;
  callSid?: string;           // telephony only
  conversationId?: string;    // in-app only
  customerId?: string;        // set after identifying
  /**
   * QA-2026-06-04: classifier confidence captured at intent_classified so the
   * eventual create_proposal side-effect can thread a REAL confidenceScore
   * into the proposal (auto-approve thresholds). Without it the calling-agent
   * proposals were born 'draft' with no trust tier — unapprovable once the
   * draft guard landed.
   */
  lastIntentConfidence?: number;
  /**
   * The persisted `ai_runs` id of the classify call that produced the current
   * intent (from the `intent_classified` event's `aiRunId`). Captured at
   * intent_classified alongside `lastIntentConfidence` so the eventual
   * `create_proposal` side-effect can thread a REAL run id into the proposal
   * (proposals.ai_run_id FK). Undefined when the classifier short-circuited
   * without an LLM call or no AiRunRepository is wired — the proposal builder
   * then leaves ai_run_id null rather than fabricating one.
   */
  lastAiRunId?: string;
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
  /**
   * F8 — per-tenant escalation trigger toggles (from CallRoutingSheet).
   * When absent, all triggers default to enabled.
   */
  escalationTriggers?: {
    trigger_low_confidence: boolean;
    trigger_explicit_request: boolean;
    trigger_keyword_frustration: boolean;
  };
  /**
   * RV-070 — true when the inbound caller-ID matched an approver phone
   * (`tenant_settings.owner_phone` or the backup supervisor's mobile,
   * normalized — same identity logic as the SMS reply transport; see
   * `proposals/approver-identity.ts`). Set ONCE where the session is
   * established (telephony adapter) and never from utterance content.
   *
   * Inert for every existing FSM flow — the transition table does not
   * read it. It gates the voice approval channel (RV-071): the
   * `approve_proposal` / `reject_proposal` intents are only routed when
   * this is true.
   */
  ownerSession?: boolean;
  /**
   * Phase-2 Track A — resolved once at session establishment from the
   * tenant `voice_extended_intents` flag. When true the live-call
   * classifier appends the extended owner-lookup/complaint prompt section.
   */
  extendedIntents?: boolean;
  /**
   * N-003 (P2-036) — set once the negotiation guardrail has fired this
   * session. The guardrail speaks a holding line on every negotiation turn
   * (so a haggling caller is always deflected) but creates the owner callback
   * only on the FIRST one, so repeated pushback doesn't spawn a callback per
   * turn. Inert for every other flow — only the negotiation global guard reads it.
   */
  negotiationFlagged?: boolean;
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

// ─── Payload schema (runtime validation) ─────────────────────────────────────

/**
 * Zod schema for `escalate_with_context` side-effect payloads.
 * Used by `TwilioMediaStreamAdapter.emitSideEffects` to validate the raw
 * `fx.payload` before dispatching to `handleEscalateWithContext`. Invalid
 * payloads are logged and dropped — they never reach the handler.
 */
export const escalateWithContextPayloadSchema = z.object({
  escalationId: z.string().min(1),
  summary: z.object({
    whisper: z.string(),
    sms: z.string(),
    panel: z.object({
      header: z.object({
        title: z.string(),
        callerName: z.string(),
        callerPhone: z.string(),
      }),
      customer: z.object({
        name: z.string(),
        phone: z.string(),
        tags: z.array(z.string()),
      }),
      lastInteraction: z.union([z.string(), z.null()]),
      intent: z.object({
        summary: z.string(),
        entities: z.array(z.object({ key: z.string(), value: z.string() })),
      }),
      reason: z.object({
        code: z.string(),
        humanReadable: z.string(),
      }),
      transcriptSnapshot: z.array(z.object({
        role: z.union([z.literal('caller'), z.literal('ai')]),
        text: z.string(),
        ts: z.number(),
      })),
    }),
  }),
  dispatcher: z.object({
    userId: z.string().min(1),
    phone: z.string().min(1),
  }),
  callSid: z.string().min(1),
  tenantId: z.string().min(1),
  channelPreferences: z.object({
    sms: z.boolean(),
    in_app: z.boolean(),
    whisper: z.boolean(),
  }),
});

// ─── Transition result ────────────────────────────────────────────────────────

export interface TransitionResult {
  nextState: CallingAgentState;
  sideEffects: SideEffect[];
  updatedContext: CallingAgentContext;
}
