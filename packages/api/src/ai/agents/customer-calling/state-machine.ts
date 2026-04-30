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
}
