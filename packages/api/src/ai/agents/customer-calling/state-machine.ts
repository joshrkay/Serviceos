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
   * B3-1 — the owner line's privileges for the coming turn. The voice turn
   * processor re-resolves a caller-ID-established owner line before every
   * turn (`refreshOwnerLine`): a line that no longer resolves (a backup
   * deactivated or replaced mid-call, the owner phone changed, the lookup
   * failed) loses `ownerSession` and `extendedIntents` for that turn, and a
   * later turn that resolves it again gets them back. Driven only by that
   * caller-ID re-check, never by utterance content. No state change. B4-4 —
   * the extended lookups are an owner-line privilege: never set without
   * `ownerSession` (establishment grants them the same way).
   */
  setOwnerLinePrivileges(privileges: { ownerSession: boolean; extendedIntents: boolean }): void {
    const next: CallingAgentContext = { ...this.context };
    delete next.ownerSession;
    delete next.extendedIntents;
    if (privileges.ownerSession) next.ownerSession = true;
    if (privileges.ownerSession && privileges.extendedIntents) next.extendedIntents = true;
    this.context = next;
  }

  /**
   * PRIV-3 — pass every piece of the caller's words the context holds
   * (`lastUtterance`, the classifier's extracted entities, a pending
   * reference) through `rewrite`. Called when a later turn shows an earlier
   * one held part of a card number the caller split across turns: the request
   * parked from that turn would otherwise put the fragment in the proposal it
   * drafts. Ids (`id`, `…Id`, `…Ids`, `…Sid` keys) are never rewritten.
   */
  rewriteCapturedText(rewrite: (text: string) => string): void {
    this.context = rewriteStrings(this.context, rewrite);
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

/** Keys whose values are ids, never caller words. */
const ID_KEY = /^(?:id|.*(?:Id|Ids|Sid))$/;

/**
 * PRIV-3 — `value` with every string under a non-id key rewritten (ids:
 * `id`, `…Id`, `…Ids`, `…Sid` keys); unchanged objects are returned as they
 * were. Also used for the caller's words a held request keeps outside the
 * context (`VoiceSession.rebookOffer.entities`).
 */
export function rewriteStrings<T>(value: T, rewrite: (text: string) => string, key = ''): T {
  if (typeof value === 'string') return (ID_KEY.test(key) ? value : rewrite(value)) as T;
  if (Array.isArray(value)) {
    const next = value.map((item) => rewriteStrings(item, rewrite, key));
    return (next.some((item, i) => item !== value[i]) ? next : value) as T;
  }
  if (value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      next[k] = rewriteStrings(v, rewrite, k);
      if (next[k] !== v) changed = true;
    }
    return (changed ? next : value) as T;
  }
  return value;
}
