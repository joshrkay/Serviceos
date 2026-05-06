/**
 * VQ-004 — Observation capture record.
 *
 * The `Observation` is the data structure passed to graders after every
 * scripted call. It bundles everything a grader could plausibly assert
 * against — the raw event log captured by `AgentEventBus`, post-call
 * proposal/customer/appointment snapshots, audit trail, derived cost +
 * timing metrics, and a normalized session-end classification — into a
 * single immutable-ish record.
 *
 * The builder is a *pure function*: no I/O, no mutation of inputs, no
 * timer access. All time-derived numbers (perTurnLatencyMs, totalDurationMs)
 * come from event timestamps + the explicit `callStartedAtMs` /
 * `callEndedAtMs` arguments so tests are deterministic and
 * deepEqual-friendly.
 *
 * Defensive copies are made for events/proposals/audit so a grader that
 * accidentally pushes into one of those arrays cannot bleed back into the
 * harness's `AgentEventBus` or the underlying repo snapshot.
 */
import type { VoiceSessionEvent } from '../agents/customer-calling/voice-session-store';
import type { AuditEvent } from '../../audit/audit';
import type { Proposal } from '../../proposals/proposal';
import type { AgentEventBus } from './event-bus';

export interface Observation {
  callId: string;
  scriptId: string;
  tenantId: string;
  /** Captured by the event bus, ordered by emit time. Defensive copy. */
  events: VoiceSessionEvent[];
  /**
   * Snapshot of `proposalRepo.findByTenant(tenantId)` taken AFTER the
   * call returned. Typed as `Proposal[]` when the harness uses the
   * default repo; the field is widened to `unknown[]` on the input side
   * so test fixtures can pass synthetic rows without faking every field.
   */
  proposals: Proposal[];
  customerCountDelta: number;
  appointmentCountDelta: number;
  /** Defensive copy of any audit events emitted during the call. */
  audit: AuditEvent[];
  totalCostCents: number;
  totalDurationMs: number;
  /**
   * Approximate latency per agent turn, in ms. v1 heuristic: deltas
   * between consecutive `intent_classified` events, with a tail entry
   * `callEndedAtMs - lastIntentClassified.ts` so we always emit one
   * number per turn the agent took. With zero intent_classified events
   * this is `[]`. Will be refined to lookup→speak boundaries in a later
   * task once the speak side-effect carries a timestamp.
   */
  perTurnLatencyMs: number[];
  sessionEndedAs: 'completed' | 'terminated';
  hangupOccurred: boolean;
  /** One entry per failed `lookup_executed` event. */
  errors: { event: string; message: string }[];
}

export interface ObservationBuilderInput {
  callId: string;
  scriptId: string;
  tenantId: string;
  bus: AgentEventBus;
  /** From a proposal repo `.findByTenant(tenantId)` snapshot post-call. */
  proposalsAfter: Proposal[] | unknown[];
  customerCountBefore: number;
  customerCountAfter: number;
  appointmentCountBefore: number;
  appointmentCountAfter: number;
  audit: AuditEvent[];
  callStartedAtMs: number;
  callEndedAtMs: number;
}

/**
 * Pure builder. Derives an `Observation` from the captured event bus,
 * the audit trail, and pre/post repo counts.
 *
 * The function never reads from the network or filesystem and never
 * mutates its inputs.
 */
export function buildObservation(input: ObservationBuilderInput): Observation {
  // Defensive copy of the bus's event log. `bus.events()` returns a
  // readonly view, but we still spread so a grader that mutates
  // `obs.events` cannot reach into the bus's private array.
  const events: VoiceSessionEvent[] = [...input.bus.events()];

  // Total cost: the latest cost_incurred event carries the running total
  // (cost tracker emits monotonically). When no cost was incurred,
  // default to 0.
  let totalCostCents = 0;
  for (const e of events) {
    if (e.type === 'cost_incurred') {
      totalCostCents = e.totalCents;
    }
  }

  // Per-turn latency: deltas between consecutive intent_classified
  // events, plus a tail entry to `callEndedAtMs`. Empty when the agent
  // never classified an intent (e.g., a script that hung up before any
  // gather turn).
  const intentTimestamps: number[] = [];
  for (const e of events) {
    if (e.type === 'intent_classified') intentTimestamps.push(e.ts);
  }
  const perTurnLatencyMs: number[] = [];
  for (let i = 1; i < intentTimestamps.length; i++) {
    perTurnLatencyMs.push(intentTimestamps[i] - intentTimestamps[i - 1]);
  }
  if (intentTimestamps.length > 0) {
    perTurnLatencyMs.push(input.callEndedAtMs - intentTimestamps[intentTimestamps.length - 1]);
  }

  // Session end classification. The last session_terminated event wins;
  // if none fired (e.g., harness aborted) we conservatively call it
  // 'terminated' since the script did not formally complete.
  let sessionEndedAs: 'completed' | 'terminated' = 'terminated';
  let hangupOccurred = false;
  for (const e of events) {
    if (e.type === 'session_terminated') {
      sessionEndedAs = e.cause === 'completed' ? 'completed' : 'terminated';
      if (e.cause === 'hangup') hangupOccurred = true;
    }
  }

  // Errors: every failed lookup_executed becomes an entry. We use
  // `skillName` as the event name and the optional `error` string as
  // the message (falling back to a generic label so graders never see
  // `undefined` rendered).
  const errors: { event: string; message: string }[] = [];
  for (const e of events) {
    if (e.type === 'lookup_executed' && !e.success) {
      errors.push({ event: e.skillName, message: e.error ?? 'unknown error' });
    }
  }

  return {
    callId: input.callId,
    scriptId: input.scriptId,
    tenantId: input.tenantId,
    events,
    // Cast through the union so callers passing `unknown[]` (synthetic
    // fixtures) still typecheck; the runtime value is just passed through.
    proposals: [...(input.proposalsAfter as Proposal[])],
    customerCountDelta: input.customerCountAfter - input.customerCountBefore,
    appointmentCountDelta: input.appointmentCountAfter - input.appointmentCountBefore,
    audit: [...input.audit],
    totalCostCents,
    totalDurationMs: input.callEndedAtMs - input.callStartedAtMs,
    perTurnLatencyMs,
    sessionEndedAs,
    hangupOccurred,
    errors,
  };
}
