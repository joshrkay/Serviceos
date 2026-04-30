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
  | { type: 'proposal_created'; proposalId: string };

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
  /** Set after `endSession()` to short-circuit further input. */
  ended: boolean;
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
      events: new EventEmitter(),
    };
    this.sessions.set(id, session);
    return session;
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
