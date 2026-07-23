/**
 * Customer Calling Agent — Transition Table
 *
 * Pure function: (state, event, context) → (nextState, sideEffects, updatedContext).
 * No I/O, no async, no imports from infrastructure.
 *
 * Spec: docs/superpowers/agents/customer-calling/flow.md
 */

import type {
  CallingAgentState,
  CallingAgentEvent,
  CallingAgentContext,
  TransitionResult,
  SideEffect,
} from './types';
import type { EntityKind } from '../../resolution/entity-resolver';
import { selectRepairTemplate } from './repair-templates';
import { EMERGENCY_SAFETY_LINE } from './emergency-detector';

// ─── Thresholds ───────────────────────────────────────────────────────────────

/**
 * Intent classification confidence threshold (τ_int). Below this the
 * FSM treats a classified intent as `confidence_low` and reprompts.
 *
 * Exported so adapters (telephony, in-app) gate the same way the FSM
 * does — keeps the act-on-intent threshold consistent across channels
 * instead of letting each adapter pick its own number.
 */
export const TAU_INT = 0.75;

/** Maximum retries in ask_caller substate before escalating */
const MAX_ASK_CALLER_RETRIES = 2;

/** Maximum reprompts in intent_capture before escalating */
const MAX_INTENT_CAPTURE_RETRIES = 1;

/**
 * Hard cap on consecutive `confidence_low` events per session. Bounds the
 * silent-caller / broken-classifier loop so the FSM escalates instead of
 * waiting on the 30-minute idle reaper.
 */
const MAX_REPROMPTS = 3;

/**
 * WS18 — hard cap on how many times a caller may refine a live quote before the
 * agent stops editing and defers to the owner. Bounds a caller who keeps
 * re-tweaking line items so the agent can never be looped forever. Exported so
 * the settings-aware voice-turn processor's deterministic pre-check reads the
 * SAME cap it does (a re-ground is skipped once the cap is reached).
 */
export const MAX_REFINEMENTS_PER_CALL = 3;

/**
 * WS18 — spoken when the refinement cap is hit: the agent stops editing the
 * live quote and hands it to the owner to finalize. The processor pairs this
 * with a one-tap owner fallback. Deliberately makes NO booking claim.
 */
export const REFINEMENT_CAP_LINE =
  'Let me have the owner finalize the details and send you the full quote by text.';

/**
 * WS18 — bounded reprompt spoken in `closing` when the caller's response to a
 * live quote is low-confidence (empty / unintelligible). Closes the dead-air
 * hole where a `confidence_low` in `closing` previously fell through to an
 * ignored transition and the caller heard silence. Governed by the existing
 * repromptCount / MAX_REPROMPTS budget.
 */
export const POST_QUOTE_REPROMPT_LINE =
  'Sorry — did you want me to lock that in, or is there something to change?';

/**
 * N-003 (P2-036) — deterministic holding line spoken when the caller pushes on
 * price, scope, or terms. The agent must never negotiate; it defers to the owner.
 * The pure FSM emits this FIXED fallback (it can't load async settings) tagged
 * `source: 'negotiation_holding'`; the settings-aware voice-turn processor swaps
 * it for the brand-voiced composer (conversations/negotiation/acknowledgment.ts)
 * so the live call sounds like the shop, matching the SMS channel. Exported so
 * adapters/tests share it.
 */
export const NEGOTIATION_HOLDING_LINE =
  "That's a good question — I'll need to check with the owner on that, and we'll get right back to you. Is there anything else I can help with in the meantime?";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function auditLog(
  context: CallingAgentContext,
  fromState: CallingAgentState,
  toState: CallingAgentState,
  eventType: string,
  extra?: Record<string, unknown>
): SideEffect {
  return {
    type: 'audit_log',
    payload: {
      eventType: `agent.calling.${fromState}.${eventType}`,
      fromState,
      toState,
      sessionId: context.sessionId,
      tenantId: context.tenantId,
      conversationId: context.conversationId,
      callSid: context.callSid,
      ts: Date.now(),
      ...extra,
    },
  };
}

function ttsPlay(text: string, extra?: Record<string, unknown>): SideEffect {
  return {
    type: 'tts_play',
    payload: { text, ...extra },
  };
}

function endSession(context: CallingAgentContext, reason: string): SideEffect {
  return {
    type: 'end_session',
    payload: {
      sessionId: context.sessionId,
      tenantId: context.tenantId,
      reason,
    },
  };
}

function notifyOncall(context: CallingAgentContext, reason: string): SideEffect {
  return {
    type: 'notify_oncall',
    payload: {
      sessionId: context.sessionId,
      tenantId: context.tenantId,
      reason,
      callSid: context.callSid,
      conversationId: context.conversationId,
    },
  };
}

/** Ignored-event log: same state, log only */
function ignoredTransition(
  state: CallingAgentState,
  event: CallingAgentEvent,
  context: CallingAgentContext
): TransitionResult {
  return {
    nextState: state,
    sideEffects: [
      {
        type: 'audit_log',
        payload: {
          eventType: `agent.calling.${state}.event_ignored`,
          state,
          ignoredEvent: event.type,
          sessionId: context.sessionId,
          tenantId: context.tenantId,
          ts: Date.now(),
        },
      },
    ],
    updatedContext: context,
  };
}

// ─── Global guards (apply from any state) ────────────────────────────────────

/**
 * Check events that cause universal transitions regardless of current state.
 * Returns a TransitionResult if the event triggers a global guard, otherwise null.
 */
function checkGlobalGuards(
  state: CallingAgentState,
  event: CallingAgentEvent,
  context: CallingAgentContext
): TransitionResult | null {
  // caller_hangup → terminated (any state)
  if (event.type === 'caller_hangup') {
    return {
      nextState: 'terminated',
      sideEffects: [
        auditLog(context, state, 'terminated', 'caller_hangup'),
        endSession(context, 'caller_hangup'),
      ],
      updatedContext: context,
    };
  }

  // abuse_detected → terminated (any state)
  if (event.type === 'abuse_detected') {
    return {
      nextState: 'terminated',
      sideEffects: [
        auditLog(context, state, 'terminated', 'abuse_detected', { category: event.category }),
        ttsPlay('This call has been terminated due to policy violations.'),
        endSession(context, `abuse_detected:${event.category}`),
      ],
      updatedContext: { ...context, escalationReason: `abuse_detected:${event.category}` },
    };
  }

  // caller_identification_failed → escalating (any state). The telephony
  // adapter dispatches this when identifyCaller throws so we don't
  // silently downgrade the caller to anonymous and create proposals
  // against the wrong customer.
  if (event.type === 'caller_identification_failed') {
    return {
      nextState: 'escalating',
      sideEffects: [
        auditLog(context, state, 'escalating', 'caller_identification_failed', {
          reason: event.reason,
        }),
        ttsPlay("I'm having trouble pulling up your account. Let me connect you with a team member."),
        notifyOncall(context, 'caller_identification_failed'),
      ],
      updatedContext: { ...context, escalationReason: 'caller_identification_failed' },
    };
  }

  // system_failure → escalating (any state). Dispatched when a side-effect
  // execution fails in a way that strands the FSM (e.g., proposalRepo.create
  // throws, leaving us in proposal_draft with no way out). Without this,
  // subsequent gather turns hit the "unhandled state" branch and the caller
  // gets looped forever.
  if (event.type === 'system_failure') {
    return {
      nextState: 'escalating',
      sideEffects: [
        auditLog(context, state, 'escalating', 'system_failure', { reason: event.reason }),
        ttsPlay("I'm having trouble completing that. Let me connect you with a team member."),
        notifyOncall(context, `system_failure:${event.reason}`),
      ],
      updatedContext: { ...context, escalationReason: `system_failure:${event.reason}` },
    };
  }

  // cost_cap_exceeded → escalating (any state)
  if (event.type === 'cost_cap_exceeded') {
    return {
      nextState: 'escalating',
      sideEffects: [
        auditLog(context, state, 'escalating', 'cost_cap_exceeded'),
        ttsPlay("I'm connecting you with a team member who can assist you further."),
        notifyOncall(context, 'cost_cap_exceeded'),
      ],
      updatedContext: { ...context, escalationReason: 'cost_cap_exceeded' },
    };
  }

  // operator_request from any non-terminal state fast-paths to escalation.
  // Idempotent: skip if already in a terminal/escalating state.
  if (event.type === 'intent_classified' && event.intentType === 'operator_request') {
    if (state === 'escalating' || state === 'terminated') {
      return { nextState: state, sideEffects: [], updatedContext: context };
    }
    if (context.escalationTriggers && !context.escalationTriggers.trigger_explicit_request) {
      return {
        nextState: state,
        sideEffects: [
          ttsPlay(
            "I can help with scheduling and service questions. What do you need help with today?",
          ),
        ],
        updatedContext: context,
      };
    }
    const updatedContext: CallingAgentContext = {
      ...context,
      currentIntent: event.intentType,
      extractedEntities: event.entities,
      retryCount: 0,
      escalationReason: 'operator_request',
    };
    return {
      nextState: 'escalating',
      sideEffects: [
        auditLog(updatedContext, state, 'escalating', 'operator_request'),
        ttsPlay("Of course — let me connect you with a person right now."),
        notifyOncall(updatedContext, 'operator_request'),
      ],
      updatedContext,
    };
  }

  // N-003 (P2-036) — negotiation guardrail. The caller is pushing on price,
  // scope, or terms. The agent must NOT negotiate: it speaks a fixed holding
  // line and routes the ask to the owner (a `callback` proposal the voice-turn
  // processor enriches via the shared guardrail builder). Unlike
  // operator_request it does NOT escalate — the conversation continues in the
  // current state. Idempotent per session via `negotiationFlagged`: the holding
  // line is spoken every time (so a haggling caller is always deflected) but
  // the owner callback is created only on the first negotiation turn.
  if (event.type === 'intent_classified' && event.intentType === 'negotiation') {
    if (state === 'escalating' || state === 'terminated') {
      return { nextState: state, sideEffects: [], updatedContext: context };
    }
    const alreadyFlagged = context.negotiationFlagged === true;
    const updatedContext: CallingAgentContext = { ...context, negotiationFlagged: true };
    const sideEffects: SideEffect[] = [
      auditLog(updatedContext, state, state, 'negotiation_guardrail', { alreadyFlagged }),
      // Tagged so the settings-aware voice-turn processor can brand-voice it.
      ttsPlay(NEGOTIATION_HOLDING_LINE, { source: 'negotiation_holding' }),
    ];
    if (!alreadyFlagged) {
      sideEffects.push({
        type: 'create_proposal',
        payload: {
          tenantId: updatedContext.tenantId,
          intent: 'negotiation',
          entities: {
            ...updatedContext.extractedEntities,
            ...event.entities,
            ...(updatedContext.customerId ? { customerId: updatedContext.customerId } : {}),
          },
          sessionId: updatedContext.sessionId,
          callSid: updatedContext.callSid,
          conversationId: updatedContext.conversationId,
          customerId: updatedContext.customerId,
          // Link the negotiation callback proposal to the classify call's
          // ai_runs row (FK-satisfied) instead of null.
          ...(event.aiRunId ? { aiRunId: event.aiRunId } : {}),
        },
      });
    }
    return { nextState: state, sideEffects, updatedContext };
  }

  // RV-140/RV-142 — deterministic emergency keyword hit. Fast-paths to
  // escalating from any non-terminal state, BEFORE any LLM call. The 911
  // safety line is the FIRST side effect (RV-142) so it is always spoken
  // before any transfer copy/bridge; the create_proposal closes the
  // emergency_dispatch execution gap (RV-141) and notify_oncall drives the
  // immediate dispatcher transfer. Idempotent in escalating/terminated so a
  // repeated keyword during the transfer can't double-page.
  if (event.type === 'emergency_detected') {
    if (state === 'escalating' || state === 'terminated') {
      return { nextState: state, sideEffects: [], updatedContext: context };
    }
    const updatedContext: CallingAgentContext = {
      ...context,
      currentIntent: 'emergency_dispatch',
      escalationReason: 'emergency_dispatch',
    };
    return {
      nextState: 'escalating',
      sideEffects: [
        auditLog(updatedContext, state, 'escalating', 'emergency_detected', {
          keyword: event.keyword,
        }),
        ttsPlay(EMERGENCY_SAFETY_LINE, { priority: 'safety' }),
        ttsPlay("This sounds like an emergency. I'm connecting you with our on-call dispatcher immediately."),
        {
          type: 'create_proposal',
          payload: {
            tenantId: updatedContext.tenantId,
            intent: 'emergency_dispatch',
            entities: {
              ...updatedContext.extractedEntities,
              emergencyDescription: event.utterance,
              detectedKeywords: [event.keyword],
              // Duplicated into entities because the voice-turn processor's
              // handleCreateProposal persists only {intent, entities,
              // sessionId, callSid} — the execution handler (RV-141) reads
              // the customer from here.
              ...(updatedContext.customerId
                ? { customerId: updatedContext.customerId }
                : {}),
            },
            sessionId: updatedContext.sessionId,
            callSid: updatedContext.callSid,
            conversationId: updatedContext.conversationId,
            customerId: updatedContext.customerId,
          },
        },
        notifyOncall(updatedContext, 'emergency_dispatch'),
      ],
      updatedContext,
    };
  }

  // frustration_detected fires from keyword detector or LLM sentiment classifier.
  // Idempotent: skip if already in a terminal/escalating state.
  if (event.type === 'frustration_detected') {
    if (state === 'escalating' || state === 'terminated') {
      return { nextState: state, sideEffects: [], updatedContext: context };
    }
    if (
      event.source === 'keyword' &&
      context.escalationTriggers &&
      !context.escalationTriggers.trigger_keyword_frustration
    ) {
      return { nextState: state, sideEffects: [], updatedContext: context };
    }
    const escalationReason: CallingAgentContext['escalationReason'] =
      event.source === 'keyword' ? 'keyword_frustration' : 'llm_sentiment';
    const updatedContext: CallingAgentContext = { ...context, escalationReason };
    return {
      nextState: 'escalating',
      sideEffects: [
        auditLog(updatedContext, state, 'escalating', escalationReason),
        {
          type: 'emit_quality_event',
          payload: {
            eventType: 'frustration_escalation',
            trigger: escalationReason,
            keyword: event.detail ?? null,
            source: event.source,
            reasonHint: event.reasonHint ?? null,
          },
        },
        ttsPlay("I understand. Let me get a person on the line for you right away."),
        notifyOncall(updatedContext, escalationReason),
      ],
      updatedContext,
    };
  }

  return null;
}

// ─── State-specific transitions ───────────────────────────────────────────────

function transitionIdle(
  event: CallingAgentEvent,
  context: CallingAgentContext
): TransitionResult {
  if (event.type === 'session_started') {
    const updatedContext: CallingAgentContext = {
      ...context,
      tenantId: event.tenantId,
      conversationId: event.conversationId,
    };
    return {
      nextState: 'greeting',
      sideEffects: [
        auditLog(updatedContext, 'idle', 'greeting', 'session_started'),
        ttsPlay('greeting', { template: 'greeting', tenantId: event.tenantId }),
      ],
      updatedContext,
    };
  }

  if (event.type === 'incoming_call') {
    const updatedContext: CallingAgentContext = {
      ...context,
      tenantId: event.tenantId,
      callSid: event.callSid,
    };
    return {
      nextState: 'greeting',
      sideEffects: [
        auditLog(updatedContext, 'idle', 'greeting', 'incoming_call', {
          from: event.from,
          to: event.to,
        }),
        ttsPlay('greeting', { template: 'greeting_with_disclosure', tenantId: event.tenantId }),
      ],
      updatedContext,
    };
  }

  return ignoredTransition('idle', event, context);
}

function transitionGreeting(
  event: CallingAgentEvent,
  context: CallingAgentContext
): TransitionResult {
  if (event.type === 'greeted_ok') {
    return {
      nextState: 'identifying',
      sideEffects: [
        auditLog(context, 'greeting', 'identifying', 'greeted_ok'),
      ],
      updatedContext: context,
    };
  }

  return ignoredTransition('greeting', event, context);
}

function transitionIdentifying(
  event: CallingAgentEvent,
  context: CallingAgentContext
): TransitionResult {
  if (event.type === 'operator_session') {
    return {
      nextState: 'intent_capture',
      sideEffects: [
        auditLog(context, 'identifying', 'intent_capture', 'operator_session'),
        ttsPlay('How can I help you today?'),
      ],
      updatedContext: context,
    };
  }

  if (event.type === 'caller_known') {
    const updatedContext: CallingAgentContext = {
      ...context,
      customerId: event.customerId,
    };
    return {
      nextState: 'intent_capture',
      sideEffects: [
        auditLog(updatedContext, 'identifying', 'intent_capture', 'caller_known', {
          customerId: event.customerId,
        }),
        ttsPlay('How can I help you today?'),
      ],
      updatedContext,
    };
  }

  if (event.type === 'unknown_caller') {
    return {
      nextState: 'ask_caller',
      sideEffects: [
        auditLog(context, 'identifying', 'ask_caller', 'unknown_caller'),
        ttsPlay("What's your name and the address you're calling about?"),
      ],
      updatedContext: { ...context, retryCount: 0 },
    };
  }

  return ignoredTransition('identifying', event, context);
}

function transitionAskCaller(
  event: CallingAgentEvent,
  context: CallingAgentContext
): TransitionResult {
  // caller_known after providing info → intent_capture
  if (event.type === 'caller_known') {
    const updatedContext: CallingAgentContext = {
      ...context,
      customerId: event.customerId,
      retryCount: 0,
    };
    return {
      nextState: 'intent_capture',
      sideEffects: [
        auditLog(updatedContext, 'ask_caller', 'intent_capture', 'caller_known', {
          customerId: event.customerId,
        }),
        ttsPlay('How can I help you today?'),
      ],
      updatedContext,
    };
  }

  // unknown_caller again → retry or escalate
  if (event.type === 'unknown_caller') {
    const newRetryCount = context.retryCount + 1;
    if (newRetryCount >= MAX_ASK_CALLER_RETRIES) {
      // Max retries exceeded → escalate
      return {
        nextState: 'escalating',
        sideEffects: [
          auditLog(context, 'ask_caller', 'escalating', 'max_retries_exceeded', {
            retryCount: newRetryCount,
          }),
          ttsPlay("I'm having trouble verifying your identity. Let me connect you with a team member."),
          notifyOncall(context, 'caller_identity_unresolved'),
        ],
        updatedContext: {
          ...context,
          retryCount: newRetryCount,
          escalationReason: 'caller_identity_unresolved',
        },
      };
    }

    // Retry: reprompt
    return {
      nextState: 'ask_caller',
      sideEffects: [
        auditLog(context, 'ask_caller', 'ask_caller', 'retry_ask', { retryCount: newRetryCount }),
        ttsPlay("I'm sorry, I couldn't find your account. Can you please provide your full name and service address?"),
      ],
      updatedContext: { ...context, retryCount: newRetryCount },
    };
  }

  return ignoredTransition('ask_caller', event, context);
}

function transitionIntentCapture(
  event: CallingAgentEvent,
  context: CallingAgentContext
): TransitionResult {
  if (event.type === 'intent_classified') {
    // emergency_dispatch → fast-path directly to escalating (skip entity_resolution and intent_confirm)
    if (event.intentType === 'emergency_dispatch') {
      const updatedContext: CallingAgentContext = {
        ...context,
        currentIntent: event.intentType,
        extractedEntities: event.entities,
        retryCount: 0,
        escalationReason: 'emergency_dispatch',
      };
      return {
        nextState: 'escalating',
        sideEffects: [
          auditLog(updatedContext, 'intent_capture', 'escalating', 'emergency_dispatch'),
          // RV-142 — safety script first, before any transfer copy/bridge.
          ttsPlay(EMERGENCY_SAFETY_LINE, { priority: 'safety' }),
          ttsPlay("This sounds like an emergency. I'm connecting you with our on-call dispatcher immediately."),
          notifyOncall(updatedContext, 'emergency_dispatch'),
        ],
        updatedContext,
      };
    }

    // operator_request is handled by checkGlobalGuards and never reaches here.
    // Confidence at or above threshold → entity_resolution. Unknown never
    // advances even with a high score — adapters may emit intent_classified
    // with intentType 'unknown' after a classifier miss.
    if (event.confidence >= TAU_INT && event.intentType !== 'unknown') {
      const updatedContext: CallingAgentContext = {
        ...context,
        currentIntent: event.intentType,
        extractedEntities: event.entities,
        lastIntentConfidence: event.confidence,
        // Carry the classify call's ai_runs id forward so the eventual
        // create_proposal (after confirm) links the proposal to a REAL run.
        // Set UNCONDITIONALLY (not a conditional spread): a re-classification
        // whose turn has no persisted run must CLEAR the prior turn's id, or
        // the `...context` spread above would leak the previous run and the
        // eventual create_proposal would link to the WRONG ai_runs record.
        lastAiRunId: event.aiRunId,
        retryCount: 0,
      };
      return {
        nextState: 'entity_resolution',
        sideEffects: [
          auditLog(updatedContext, 'intent_capture', 'entity_resolution', 'intent_classified', {
            intentType: event.intentType,
            confidence: event.confidence,
          }),
        ],
        updatedContext,
      };
    }

    // Confidence below threshold → reprompt or escalate
    const newRetryCount = context.retryCount + 1;
    if (newRetryCount > MAX_INTENT_CAPTURE_RETRIES) {
      if (
        context.escalationTriggers &&
        !context.escalationTriggers.trigger_low_confidence
      ) {
        return {
          nextState: 'intent_capture',
          sideEffects: [
            auditLog(context, 'intent_capture', 'intent_capture', 'low_confidence_cap', {
              confidence: event.confidence,
              retryCount: newRetryCount,
            }),
            ttsPlay(
              "I'm still having trouble understanding. Could you describe what you need in a few words?",
            ),
          ],
          updatedContext: { ...context, retryCount: newRetryCount },
        };
      }
      return {
        nextState: 'escalating',
        sideEffects: [
          auditLog(context, 'intent_capture', 'escalating', 'low_confidence_max_retries', {
            confidence: event.confidence,
            retryCount: newRetryCount,
          }),
          ttsPlay("I'm having trouble understanding your request. Let me connect you with a team member."),
          notifyOncall(context, 'low_confidence_intent'),
        ],
        updatedContext: {
          ...context,
          retryCount: newRetryCount,
          escalationReason: 'low_confidence_intent',
        },
      };
    }

    // Reprompt
    {
      const repair = selectRepairTemplate(context.repairTemplates ?? [], {
        trigger: 'low_intent_confidence',
      });
      const repromptText = repair?.text ?? "I want to make sure I got that right — can you say that again?";
      return {
        nextState: 'intent_capture',
        sideEffects: [
          auditLog(context, 'intent_capture', 'intent_capture', 'reprompt', {
            confidence: event.confidence,
            retryCount: newRetryCount,
          }),
          {
            type: 'emit_quality_event',
            payload: {
              eventType: 'repair_template_fired',
              trigger: 'low_intent_confidence',
              text: repromptText,
            },
          },
          ttsPlay(repromptText),
        ],
        updatedContext: { ...context, retryCount: newRetryCount },
      };
    }
  }

  // confidence_low internal event (alternative path)
  if (event.type === 'confidence_low') {
    const newRetryCount = context.retryCount + 1;
    const newRepromptCount = context.repromptCount + 1;
    // Hard cap on cumulative reprompts across the session — bounds the
    // empty-SpeechResult / broken-classifier loop independently of the
    // per-state retryCount.
    if (newRepromptCount >= MAX_REPROMPTS || newRetryCount > MAX_INTENT_CAPTURE_RETRIES) {
      return {
        nextState: 'escalating',
        sideEffects: [
          auditLog(context, 'intent_capture', 'escalating', 'low_confidence_max_retries', {
            threshold: event.threshold,
            score: event.score,
            retryCount: newRetryCount,
            repromptCount: newRepromptCount,
          }),
          ttsPlay("I'm having trouble understanding your request. Let me connect you with a team member."),
          notifyOncall(context, 'low_confidence_intent'),
        ],
        updatedContext: {
          ...context,
          retryCount: newRetryCount,
          repromptCount: newRepromptCount,
          escalationReason: 'low_confidence_intent',
        },
      };
    }

    {
      const repair = selectRepairTemplate(context.repairTemplates ?? [], {
        trigger: 'low_audio_confidence',
      });
      const repromptText = repair?.text ?? "I want to make sure I got that right — can you say that again?";
      return {
        nextState: 'intent_capture',
        sideEffects: [
          auditLog(context, 'intent_capture', 'intent_capture', 'reprompt', {
            threshold: event.threshold,
            score: event.score,
            retryCount: newRetryCount,
            repromptCount: newRepromptCount,
          }),
          {
            type: 'emit_quality_event',
            payload: {
              eventType: 'repair_template_fired',
              trigger: 'low_audio_confidence',
              text: repromptText,
            },
          },
          ttsPlay(repromptText),
        ],
        updatedContext: {
          ...context,
          retryCount: newRetryCount,
          repromptCount: newRepromptCount,
        },
      };
    }
  }

  return ignoredTransition('intent_capture', event, context);
}

function transitionEntityResolution(
  event: CallingAgentEvent,
  context: CallingAgentContext
): TransitionResult {
  if (event.type === 'entity_resolved') {
    return {
      nextState: 'intent_confirm',
      sideEffects: [
        auditLog(context, 'entity_resolution', 'intent_confirm', 'entity_resolved'),
        ttsPlay('intent_confirm', { template: 'confirm_intent', intent: context.currentIntent }),
      ],
      updatedContext: {
        ...context,
        extractedEntities: { ...context.extractedEntities, ...event.refs },
        pendingEntityAmbiguity: undefined,
      },
    };
  }

  // entity_ambiguous → ask disambiguation question (stay in entity_resolution)
  if (event.type === 'entity_ambiguous') {
    const priorAttempt = context.pendingEntityAmbiguity?.attemptCount ?? 0;
    return {
      nextState: 'entity_resolution',
      sideEffects: [
        auditLog(context, 'entity_resolution', 'entity_resolution', 'entity_ambiguous', {
          candidateCount: event.candidates.length,
          ...(event.retry ? { retryAttempt: priorAttempt + 1 } : {}),
        }),
        ttsPlay('entity_disambiguate', {
          template: 'disambiguate',
          candidates: event.candidates,
        }),
      ],
      updatedContext: {
        ...context,
        pendingEntityAmbiguity: {
          entityKind: event.entityKind as EntityKind,
          reference: event.reference,
          refKey: event.refKey,
          candidates: event.candidates,
          partialRefs: event.partialRefs,
          attemptCount: event.retry ? priorAttempt + 1 : 0,
        },
      },
    };
  }

  // entity_not_found → escalate
  if (event.type === 'entity_not_found') {
    return {
      nextState: 'escalating',
      sideEffects: [
        auditLog(context, 'entity_resolution', 'escalating', 'entity_not_found'),
        ttsPlay("I wasn't able to find the record you're referring to. Let me connect you with a team member."),
        notifyOncall(context, 'entity_not_found'),
      ],
      updatedContext: { ...context, escalationReason: 'entity_not_found' },
    };
  }

  return ignoredTransition('entity_resolution', event, context);
}

function transitionIntentConfirm(
  event: CallingAgentEvent,
  context: CallingAgentContext
): TransitionResult {
  if (event.type === 'confirmed') {
    return {
      nextState: 'proposal_draft',
      sideEffects: [
        auditLog(context, 'intent_confirm', 'proposal_draft', 'confirmed'),
        {
          type: 'create_proposal',
          payload: {
            tenantId: context.tenantId,
            intent: context.currentIntent,
            entities: context.extractedEntities,
            sessionId: context.sessionId,
            callSid: context.callSid,
            conversationId: context.conversationId,
            customerId: context.customerId,
            // Real classifier confidence (caller has also explicitly
            // confirmed the intent by this point) — see types.ts.
            confidence: context.lastIntentConfidence,
            // Real ai_runs id from the classify call so the proposal builder
            // sets proposals.ai_run_id to an actual row (FK-satisfied), not
            // null. Omitted when the classify call had no persisted run.
            ...(context.lastAiRunId ? { aiRunId: context.lastAiRunId } : {}),
          },
        },
      ],
      updatedContext: { ...context, retryCount: 0 },
    };
  }

  // correction → back to intent_capture
  if (event.type === 'correction') {
    return {
      nextState: 'intent_capture',
      sideEffects: [
        auditLog(context, 'intent_confirm', 'intent_capture', 'correction', {
          newTranscript: event.newTranscript,
        }),
        ttsPlay("My apologies — let me try again. What would you like to do?"),
      ],
      updatedContext: {
        ...context,
        currentIntent: undefined,
        extractedEntities: undefined,
        // Abandon the captured turn's run id so a re-classify can't reuse it.
        lastAiRunId: undefined,
        retryCount: 0,
      },
    };
  }

  // operator_request is handled by checkGlobalGuards and never reaches here.
  // intent_classified in intent_confirm → treat as correction
  if (event.type === 'intent_classified') {
    return {
      nextState: 'intent_capture',
      sideEffects: [
        auditLog(context, 'intent_confirm', 'intent_capture', 'correction_via_reclassify'),
        ttsPlay("Let me make sure I understand — what would you like to do?"),
      ],
      updatedContext: {
        ...context,
        currentIntent: undefined,
        extractedEntities: undefined,
        // Abandon the captured turn's run id so a re-classify can't reuse it.
        lastAiRunId: undefined,
        retryCount: 0,
      },
    };
  }

  return ignoredTransition('intent_confirm', event, context);
}

function transitionProposalDraft(
  event: CallingAgentEvent,
  context: CallingAgentContext
): TransitionResult {
  if (event.type === 'proposal_queued') {
    // WS18 — when the queued proposal is a catalog-grounded estimate the
    // processor carries the read-back's structured lines + total, so we stash a
    // `pendingQuote` on the context. This is what makes the drafted quote
    // refinable ("actually, make it two") and closeable ("yes, book it") in
    // `closing` instead of being silently discarded. Absent for every
    // non-estimate proposal → pendingQuote stays undefined → closing is
    // byte-for-byte the pre-WS18 behavior.
    const updatedContext: CallingAgentContext = {
      ...context,
      pendingProposalId: event.proposalId,
      ...(event.groundedLines
        ? {
            pendingQuote: {
              proposalId: event.proposalId,
              groundedLines: event.groundedLines,
              groundedClean: event.groundedClean === true,
              totalCents:
                typeof event.totalCents === 'number' ? event.totalCents : 0,
              refinementCount: 0,
            },
          }
        : {}),
    };
    return {
      nextState: 'closing',
      sideEffects: [
        auditLog(context, 'proposal_draft', 'closing', 'proposal_queued', {
          proposalId: event.proposalId,
        }),
        // WS5 — a drafted estimate carries a catalog-grounded quote read-back
        // (event.utterance), computed synchronously by the voice-turn
        // processor. Never an LLM-invented number, and no number at all for
        // uncatalogued work. Every other proposal type keeps the fixed line.
        ttsPlay(
          event.utterance ??
            "Great, I've got that taken care of. You'll receive a confirmation shortly. Is there anything else I can help you with?",
        ),
      ],
      updatedContext,
    };
  }

  return ignoredTransition('proposal_draft', event, context);
}

function transitionClosing(
  event: CallingAgentEvent,
  context: CallingAgentContext
): TransitionResult {
  if (event.type === 'closed') {
    return {
      nextState: 'terminated',
      sideEffects: [
        auditLog(context, 'closing', 'terminated', 'closed'),
        ttsPlay('Thank you for calling. Have a great day!'),
        endSession(context, 'normal_close'),
      ],
      updatedContext: context,
    };
  }

  // WS18 — the caller assented to book the live quote ("yes, book it"). The
  // processor's deterministic pre-check dispatched this BEFORE the classifier,
  // so it can never be misread as a second intent (the discard bug). The FSM
  // keeps pendingQuote (the processor's D-018 close flow may fall back to the
  // owner) and stays in closing; the processor owns the spoken close + booking.
  if (event.type === 'post_quote_affirmative') {
    return {
      nextState: 'closing',
      sideEffects: [
        auditLog(context, 'closing', 'closing', 'post_quote_affirmative', {
          ...(context.pendingQuote
            ? {
                proposalId: context.pendingQuote.proposalId,
                groundedClean: context.pendingQuote.groundedClean,
              }
            : {}),
        }),
      ],
      updatedContext: context,
    };
  }

  // WS18 — the caller edited the live quote ("make it two", "also add a
  // gasket"). The processor has already re-grounded + edited the draft proposal
  // in place; here we speak the fresh read-back and stay in closing, keeping
  // (and bumping) pendingQuote. Bounded by MAX_REFINEMENTS_PER_CALL — past the
  // cap the agent stops editing and defers to the owner.
  if (event.type === 'refine_pending_quote') {
    const currentCount = context.pendingQuote?.refinementCount ?? 0;
    const newCount = currentCount + 1;
    if (newCount > MAX_REFINEMENTS_PER_CALL) {
      return {
        nextState: 'closing',
        sideEffects: [
          auditLog(context, 'closing', 'closing', 'refine_pending_quote_capped', {
            refinementCount: currentCount,
            proposalId: event.proposalId,
          }),
          ttsPlay(REFINEMENT_CAP_LINE),
        ],
        // Keep the last accepted quote — the caller can still say "yes".
        updatedContext: context,
      };
    }
    return {
      nextState: 'closing',
      sideEffects: [
        auditLog(context, 'closing', 'closing', 'refine_pending_quote', {
          refinementCount: newCount,
          proposalId: event.proposalId,
          groundedClean: event.groundedClean,
        }),
        ttsPlay(event.utterance),
      ],
      updatedContext: {
        ...context,
        pendingQuote: {
          proposalId: event.proposalId,
          groundedLines: event.groundedLines,
          groundedClean: event.groundedClean,
          totalCents: event.totalCents,
          refinementCount: newCount,
        },
      },
    };
  }

  // WS18 — low-confidence caller response to a live quote (empty / garbled).
  // Previously fell through to `ignoredTransition` → dead air. Now a bounded
  // reprompt, governed by the existing repromptCount / MAX_REPROMPTS budget, so
  // a persistently unintelligible caller still escalates to a human. Scoped to
  // pendingQuote — a non-estimate `closing` keeps its prior (ignored) behavior.
  if (event.type === 'confidence_low' && context.pendingQuote) {
    const newRepromptCount = context.repromptCount + 1;
    if (newRepromptCount >= MAX_REPROMPTS) {
      return {
        nextState: 'escalating',
        sideEffects: [
          auditLog(context, 'closing', 'escalating', 'post_quote_low_confidence_max', {
            threshold: event.threshold,
            score: event.score,
            repromptCount: newRepromptCount,
          }),
          ttsPlay("I'm having trouble understanding your request. Let me connect you with a team member."),
          notifyOncall(context, 'low_confidence_intent'),
        ],
        updatedContext: {
          ...context,
          repromptCount: newRepromptCount,
          escalationReason: 'low_confidence_intent',
        },
      };
    }
    return {
      nextState: 'closing',
      sideEffects: [
        auditLog(context, 'closing', 'closing', 'post_quote_reprompt', {
          threshold: event.threshold,
          score: event.score,
          repromptCount: newRepromptCount,
        }),
        ttsPlay(POST_QUOTE_REPROMPT_LINE),
      ],
      updatedContext: { ...context, repromptCount: newRepromptCount },
    };
  }

  // second_intent → back to intent_capture
  if (event.type === 'second_intent') {
    return {
      nextState: 'intent_capture',
      sideEffects: [
        auditLog(context, 'closing', 'intent_capture', 'second_intent'),
        ttsPlay("Of course! What else can I help you with?"),
      ],
      updatedContext: {
        ...context,
        currentIntent: undefined,
        extractedEntities: undefined,
        pendingProposalId: undefined,
        // WS18 — a genuine second intent abandons the live quote.
        pendingQuote: undefined,
        // Abandon the prior turn's run id so the second intent's proposal
        // can't inherit the first turn's ai_runs record.
        lastAiRunId: undefined,
        retryCount: 0,
      },
    };
  }

  // operator_request is handled by checkGlobalGuards and never reaches here.
  // intent_classified in closing → treat as second intent (loop back)
  if (event.type === 'intent_classified') {
    return {
      nextState: 'intent_capture',
      sideEffects: [
        auditLog(context, 'closing', 'intent_capture', 'second_intent_via_classify'),
      ],
      updatedContext: {
        ...context,
        currentIntent: undefined,
        extractedEntities: undefined,
        pendingProposalId: undefined,
        // WS18 — a genuine second intent abandons the live quote.
        pendingQuote: undefined,
        // Abandon the prior turn's run id so the second intent's proposal
        // can't inherit the first turn's ai_runs record.
        lastAiRunId: undefined,
        retryCount: 0,
      },
    };
  }

  return ignoredTransition('closing', event, context);
}

function transitionEscalatingOrDegraded(
  state: 'escalating' | 'degraded',
  event: CallingAgentEvent,
  context: CallingAgentContext
): TransitionResult {
  if (event.type === 'proposal_queued') {
    return {
      nextState: 'closing',
      sideEffects: [
        auditLog(context, state, 'closing', 'proposal_queued', {
          proposalId: event.proposalId,
        }),
      ],
      updatedContext: { ...context, pendingProposalId: event.proposalId },
    };
  }

  if (event.type === 'closed' || event.type === 'session_ended') {
    return {
      nextState: 'terminated',
      sideEffects: [
        auditLog(context, state, 'terminated', event.type),
        endSession(context, event.type),
      ],
      updatedContext: context,
    };
  }

  return ignoredTransition(state, event, context);
}

function transitionTerminated(
  event: CallingAgentEvent,
  context: CallingAgentContext
): TransitionResult {
  // terminated is a terminal state — all events are ignored
  return ignoredTransition('terminated', event, context);
}

// ─── Main transition function ─────────────────────────────────────────────────

/**
 * Pure transition function. Given (state, event, context), returns the
 * next state, side effects to execute, and updated context. No I/O.
 */
export function transition(
  currentState: CallingAgentState,
  event: CallingAgentEvent,
  context: CallingAgentContext
): { nextState: CallingAgentState; sideEffects: SideEffect[]; updatedContext: CallingAgentContext } {
  // Global guards apply from any non-terminal state
  if (currentState !== 'terminated') {
    const global = checkGlobalGuards(currentState, event, context);
    if (global) return global;
  }

  switch (currentState) {
    case 'idle':
      return transitionIdle(event, context);

    case 'greeting':
      return transitionGreeting(event, context);

    case 'identifying':
      return transitionIdentifying(event, context);

    case 'ask_caller':
      return transitionAskCaller(event, context);

    case 'intent_capture':
      return transitionIntentCapture(event, context);

    case 'entity_resolution':
      return transitionEntityResolution(event, context);

    case 'intent_confirm':
      return transitionIntentConfirm(event, context);

    case 'proposal_draft':
      return transitionProposalDraft(event, context);

    case 'closing':
      return transitionClosing(event, context);

    case 'escalating':
    case 'degraded':
      return transitionEscalatingOrDegraded(currentState, event, context);

    case 'terminated':
      return transitionTerminated(event, context);

    default: {
      // TypeScript exhaustiveness check
      const _exhaustive: never = currentState;
      return ignoredTransition(_exhaustive, event, context);
    }
  }
}
