/**
 * In-memory voice session store for the customer-calling agent.
 *
 * Phase 1 (P8-009): single-process, in-memory map keyed by sessionId.
 * Sessions idle for more than `IDLE_TTL_MS` are reaped by a setInterval
 * sweep. Future phases will swap this for Redis when the agent runs on
 * more than one Railway instance.
 *
 * Each session bundles the per-call FSM, cost tracker, transcript,
 * and an EventEmitter the SSE route subscribes to so the frontend can
 * receive transition pushes without polling.
 */

import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import { CallingAgentStateMachine } from './state-machine';
import type {
  CallingAgentChannel,
  CallingAgentContext,
  CallingAgentState,
  SideEffect,
} from './types';
import { SessionCostTracker, DEFAULT_INAPP_CAPS, DEFAULT_TELEPHONY_CAPS } from '../../skills/session-cost-tracker';
import type { CallOutcome } from '../../../voice/voice-service';

/** Session is reaped this many ms after last activity. */
export const DEFAULT_IDLE_TTL_MS = 30 * 60 * 1000;

/** How often the cleanup sweep runs. */
const DEFAULT_SWEEP_INTERVAL_MS = 60 * 1000;

export type VoiceSessionEvent =
  /** FSM transitioned to a new state. */
  | { type: 'transition'; state: CallingAgentState; event: string; sideEffects: SideEffect[] }
  /** Session was ended (normally or by reap). */
  | { type: 'ended'; reason: string }
  /** A proposal was created during this turn. */
  | { type: 'proposal_created'; proposalId: string }
  /**
   * VQ-003: classifier returned (above the confidence threshold or as
   * unknown — the harness wants to see both). `tokenUsage` matches the
   * shape used by `SessionCostTracker.recordUsage` so cost-incurred
   * accounting can chain off the same numbers.
   */
  | {
      type: 'intent_classified';
      intentType: string;
      confidence: number;
      tokenUsage: { inputTokens: number; outputTokens: number; costCents: number };
      ts: number;
    }
  /** VQ-003: a lookup-skill (read-only) ran to completion or threw. */
  | {
      type: 'lookup_executed';
      skillName: string;
      durationMs: number;
      success: boolean;
      error?: string;
      ts: number;
    }
  /** VQ-003: escalateToHuman committed. `reason` is the EscalationReason value. */
  | { type: 'escalation_triggered'; reason: string; ts: number }
  /** VQ-003: cost tracker absorbed a turn's usage. */
  | { type: 'cost_incurred'; deltaCents: number; totalCents: number; ts: number }
  /** VQ-003: session ended for one of the canonical reasons. */
  | {
      type: 'session_terminated';
      cause: 'hangup' | 'cost_cap' | 'cap_exceeded' | 'completed';
      ts: number;
    };

export interface TranscriptEntry {
  speaker: 'caller' | 'agent';
  text: string;
  ts?: number;
}

export interface VoiceSession {
  id: string;
  tenantId: string;
  channel: CallingAgentChannel;
  /** Twilio CallSid for telephony sessions; undefined for in-app. */
  callSid?: string;
  /** Linked conversation row for persisting transcript / proposals. */
  conversationId?: string;
  machine: CallingAgentStateMachine;
  costTracker: SessionCostTracker;
  /** Accumulated turns ("agent: ..." / "caller: ..."). Used by summarizeSession. */
  transcript: string[];
  proposalIds: string[];
  /**
   * CRM lead this call is currently attached to. Set by the inbound
   * adapter after `findOrCreateLeadByPhone` so subsequent gather turns
   * can attach intent/notes to the right kanban card.
   */
  leadId?: string;
  /** Set when `identifyCaller` matched an existing customer. */
  customerId?: string;
  /** Set after `endSession()` to short-circuit further input. */
  ended: boolean;
  /**
   * Typed CallOutcome derived by `deriveCallOutcome` at FSM finalize. Set
   * by the adapter's finalize step BEFORE `store.delete()` so the
   * recording-webhook → transcript_ingestion enqueue can read it off the
   * session and stamp it onto voice_recordings.outcome.
   */
  terminalOutcome?: CallOutcome;
  /**
   * Free-text reason (the `end_session` SideEffect's payload). Stored
   * alongside outcome on the voice_sessions row as a breadcrumb.
   */
  terminalReason?: string;
  createdAt: Date;
  lastActivityAt: Date;
  events: EventEmitter;
}

/** Immutable view used by telephony tests / observability. */
export interface VoiceSessionSnapshot {
  id: string;
  tenantId: string;
  channel: CallingAgentChannel;
  callSid?: string;
  state: CallingAgentState;
  context: Readonly<CallingAgentContext>;
  transcript: string[];
  proposalIds: string[];
  leadId?: string;
  customerId?: string;
  ended: boolean;
  createdAt: Date;
}

export interface VoiceSessionStoreOptions {
  /** Override idle TTL (ms). */
  idleTtlMs?: number;
  /** Override sweep interval (ms). */
  sweepIntervalMs?: number;
  /** When false, do not start the cleanup interval (for tests that
   *  drive cleanup manually via reapIdle()). Defaults to true. */
  startInterval?: boolean;
}

export class VoiceSessionStore {
  private readonly sessions = new Map<string, VoiceSession>();
  /**
   * Secondary index: Twilio CallSid → sessionId. Maintained on
   * create/delete so findByCallSid is O(1) instead of an O(n) scan
   * across all active sessions.
   */
  private readonly callSidIndex = new Map<string, string>();
  /**
   * Per-session promise chain used by withSessionLock. Both adapters
   * share this so concurrent webhook deliveries (Twilio retries, parallel
   * /input requests, etc.) are serialized against the FSM.
   */
  private readonly locks = new Map<string, Promise<void>>();
  private readonly idleTtlMs: number;
  private readonly sweepHandle: ReturnType<typeof setInterval> | null;

  constructor(options: VoiceSessionStoreOptions = {}) {
    this.idleTtlMs = options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
    const sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    const startInterval = options.startInterval ?? true;
    this.sweepHandle = startInterval
      ? setInterval(() => this.reapIdle(), sweepIntervalMs)
      : null;
    // Allow process to exit when this is the only handle pending.
    if (this.sweepHandle && typeof this.sweepHandle.unref === 'function') {
      this.sweepHandle.unref();
    }
  }

  /** Create a new session and return it. */
  create(
    tenantId: string,
    channel: CallingAgentChannel,
    opts: { callSid?: string; conversationId?: string } = {}
  ): VoiceSession {
    const id = uuidv4();
    const machine = new CallingAgentStateMachine({
      sessionId: id,
      tenantId,
      channel,
      callSid: opts.callSid,
      conversationId: opts.conversationId,
    });
    const costTracker = new SessionCostTracker(
      channel === 'inapp' ? DEFAULT_INAPP_CAPS : DEFAULT_TELEPHONY_CAPS
    );
    const now = new Date();
    const events = new EventEmitter();
    // Per-session listener cap: SSE reconnects can stack a handful of
    // listeners. 20 is comfortably above expected fan-out and silences
    // the default Node warning at 10.
    events.setMaxListeners(20);
    const session: VoiceSession = {
      id,
      tenantId,
      channel,
      callSid: opts.callSid,
      conversationId: opts.conversationId,
      machine,
      costTracker,
      transcript: [],
      proposalIds: [],
      ended: false,
      createdAt: now,
      lastActivityAt: now,
      events,
    };
    this.sessions.set(id, session);
    if (opts.callSid) this.callSidIndex.set(opts.callSid, id);
    return session;
  }

  /**
   * Look up an active session by Twilio CallSid. Used by the Twilio
   * adapter's /voice handler to detect Twilio's webhook retries within
   * the short retry window so we don't create duplicate sessions
   * (and duplicate side effects) for the same call.
   *
   * O(1) via the callSidIndex secondary index. The index is kept in
   * sync with the main map by create() and delete().
   */
  findByCallSid(callSid: string): VoiceSession | undefined {
    const id = this.callSidIndex.get(callSid);
    if (!id) return undefined;
    const session = this.sessions.get(id);
    if (!session || session.ended) return undefined;
    return session;
  }

  /**
   * Run `body` while holding the per-session lock. Serializes
   * concurrent webhook handlers (e.g., Twilio retries, parallel /input
   * requests) against the FSM dispatch + transcript mutations.
   *
   * `previous.catch(() => {})` is critical: without it, a single
   * thrown handler would poison the promise chain and break every
   * subsequent caller for that session.
   */
  async withSessionLock<T>(sessionId: string, body: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = previous.catch(() => {}).then(() => tail);
    this.locks.set(sessionId, chained);
    try {
      // Swallow upstream rejection inside the wait; the body always runs
      // after the prior caller's tail resolves (success or failure).
      await previous.catch(() => {});
      return await body();
    } finally {
      release();
      // Drop the entry only if no later caller chained on top of us.
      if (this.locks.get(sessionId) === chained) {
        this.locks.delete(sessionId);
      }
    }
  }

  /** Touch lastActivityAt on a session — used by adapters when emitting
   *  side effects so a long TTS/Gather doesn't let the reaper steal an
   *  in-flight call. No-op if the session is unknown. */
  touch(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) session.lastActivityAt = new Date();
  }

  /** Append a turn to the session transcript as a formatted string. No-op if session unknown. */
  appendTranscript(sessionId: string, entry: TranscriptEntry): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.transcript.push(`${entry.speaker}: ${entry.text}`);
    session.lastActivityAt = new Date();
  }

  /** Read-only snapshot of session state. Returns null if unknown. */
  snapshot(sessionId: string): VoiceSessionSnapshot | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    return {
      id: session.id,
      tenantId: session.tenantId,
      channel: session.channel,
      callSid: session.callSid,
      state: session.machine.currentState,
      context: session.machine.currentContext,
      transcript: [...session.transcript],
      proposalIds: [...session.proposalIds],
      leadId: session.leadId,
      customerId: session.customerId,
      ended: session.ended,
      createdAt: session.createdAt,
    };
  }

  /** Look up a session by id. Updates lastActivityAt as a side effect. */
  get(sessionId: string): VoiceSession | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    session.lastActivityAt = new Date();
    return session;
  }

  /** Read-only peek that does NOT touch lastActivityAt (used by tests / cleanup). */
  peek(sessionId: string): VoiceSession | undefined {
    return this.sessions.get(sessionId);
  }

  delete(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    // Drop subscribers so SSE handlers can flush their res.end().
    session.events.removeAllListeners();
    if (session.callSid) this.callSidIndex.delete(session.callSid);
    this.locks.delete(sessionId);
    this.sessions.delete(sessionId);
  }

  /** Number of active sessions (for telemetry / tests). */
  size(): number {
    return this.sessions.size;
  }

  /**
   * Sweep idle sessions. Public so tests can drive it deterministically
   * without waiting on the setInterval timer.
   */
  reapIdle(now: number = Date.now()): string[] {
    const reaped: string[] = [];
    for (const [id, session] of this.sessions) {
      const idleMs = now - session.lastActivityAt.getTime();
      if (idleMs >= this.idleTtlMs) {
        session.events.emit('voice-event', {
          type: 'ended',
          reason: 'idle_timeout',
        } satisfies VoiceSessionEvent);
        this.delete(id);
        reaped.push(id);
      }
    }
    return reaped;
  }

  /**
   * Stop the cleanup interval. Tests must call this in afterEach to
   * avoid leaking timers. Production calls dispose() at shutdown.
   */
  dispose(): void {
    if (this.sweepHandle) clearInterval(this.sweepHandle);
    for (const session of this.sessions.values()) {
      session.events.removeAllListeners();
    }
    this.sessions.clear();
    this.callSidIndex.clear();
    this.locks.clear();
  }
}

// ─── Singleton ───────────────────────────────────────────────────────────────

let _singleton: VoiceSessionStore | null = null;

/**
 * Default process-wide store. Lazily constructed so tests can opt out
 * of the singleton by using `new VoiceSessionStore()` directly.
 */
export function getVoiceSessionStore(): VoiceSessionStore {
  if (!_singleton) _singleton = new VoiceSessionStore();
  return _singleton;
}

/** Reset the singleton — used by app shutdown / test setup. */
export function resetVoiceSessionStore(): void {
  if (_singleton) _singleton.dispose();
  _singleton = null;
}
