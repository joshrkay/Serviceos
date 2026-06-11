/**
 * Customer Calling Agent — State Machine
 *
 * Channel-agnostic FSM for inbound customer calls. All I/O is injected;
 * the machine itself is pure: dispatch() returns side effects as data.
 *
 * Spec: docs/superpowers/agents/customer-calling/flow.md
 */

import type { CallingAgentState, CallingAgentContext, CallingAgentEvent, SideEffect } from './types';
import { transition } from './transitions';
import type { TriageDecision, UrgencyTier, VulnerabilityScore } from '@ai-service-os/shared';
import { triageDecision } from '../../vulnerability/triage-decision';

export class CallingAgentStateMachine {
  private state: CallingAgentState = 'idle';
  private context: CallingAgentContext;

  constructor(context: Omit<CallingAgentContext, 'retryCount' | 'repromptCount' | 'startedAt'>) {
    this.context = { ...context, retryCount: 0, repromptCount: 0, startedAt: Date.now() };
  }

  /** Current FSM state (read-only). */
  get currentState(): CallingAgentState {
    return this.state;
  }

  /** Current context snapshot (read-only). */
  get currentContext(): Readonly<CallingAgentContext> {
    return this.context;
  }

  /**
   * Process one event. Returns side effects to execute.
   *
   * The machine itself performs no I/O — callers are responsible for
   * executing every SideEffect in the returned array (in order).
   *
   * This method is intentionally synchronous: the FSM is a pure
   * reducer. Async work (TTS, audit writes, proposal creation) happens
   * outside, triggered by the returned side-effect list.
   */
  dispatch(event: CallingAgentEvent): SideEffect[] {
    const result = transition(this.state, event, this.context);
    this.state = result.nextState;
    this.context = result.updatedContext;
    return result.sideEffects;
  }

  /**
   * P8-016 — vulnerability triage PRE-FILTER, run at the escalation site
   * BEFORE the existing escalate-to-human call. Given the extracted
   * vulnerability score and the call's urgency tier, returns the triage
   * decision:
   *   - 'patch_owner'            → page the owner's cell (owner-cell-patch);
   *   - 'high_priority_booking'  → high-priority booking + owner notified;
   *   - 'normal'                 → FALL THROUGH to the existing escalation /
   *                                booking behavior, completely unchanged.
   *
   * Pure delegation to `triageDecision()`; the FSM itself performs no I/O.
   * Callers branch on `decision.kind` and only diverge from existing behavior
   * for the two non-'normal' kinds.
   */
  evaluateTriage(score: VulnerabilityScore, urgency: UrgencyTier): TriageDecision {
    return triageDecision(score, urgency);
  }
}
