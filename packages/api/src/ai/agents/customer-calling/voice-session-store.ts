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
import {
  REPLICA_ID,
  type VoiceEventTransport,
  type VoiceEventEnvelope,
} from './voice-event-transport';
import { CallingAgentStateMachine } from './state-machine';
import type {
  CallingAgentChannel,
  CallingAgentContext,
  CallingAgentState,
  SideEffect,
} from './types';
import type { RepairTemplate } from '../../../verticals/registry';
import { SessionCostTracker, DEFAULT_INAPP_CAPS, DEFAULT_TELEPHONY_CAPS } from '../../skills/session-cost-tracker';
import type { CallOutcome } from '../../../voice/voice-service';
import type {
  EscalationStartedEvent,
  EscalationSummaryBuiltEvent,
  WhisperPlayedEvent,
  DispatcherAnsweredEvent,
  DispatcherNoAnswerEvent,
  EscalationOutcomeEvent,
} from '../../voice-quality/events';

/**
 * Channel name for per-session voice events. Kept as a module-local
 * constant (rather than imported from event-bus.ts) to avoid a circular
 * dependency: event-bus.ts already imports VoiceSession/VoiceSessionEvent
 * from this module.
 */
const STORE_VOICE_EVENT_CHANNEL = 'voice-event';

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
      cause: 'hangup' | 'cost_cap' | 'cap_exceeded' | 'compliance_blocked' | 'completed';
      ts: number;
    }
  /**
   * VQ2-004: TTFA-start marker. The STT provider returned a final
   * transcript for the caller's turn — this is the moment the agent
   * begins formulating a response. Layer 2 uses Whisper batch (not
   * streaming VAD), so semantically this is "transcript received,"
   * not "caller silence detected." Used as the start-of-clock for
   * `ttfaPerTurn` in `voice-quality/audio/audio-timings.ts`.
   */
  | { type: 'transcript_received'; ts: number }
  /**
   * VQ2-004: TTFA-stop marker. The first outbound audio frame for a
   * new turn was just enqueued to the WS. Subsequent frames in the
   * same turn do not re-emit; the per-turn flag is reset on the next
   * `transcript_received`. `byteCount` is the chunk size of the first
   * frame for a sanity check (non-zero ⇒ real audio, not a heartbeat).
   */
  | { type: 'audio_frame_emitted'; ts: number; byteCount: number }
  /**
   * VQ2-followup: per-turn agent transcript recovered after the agent
   * finished speaking. In Layer 2 (`AudioModeDriver`) this is the
   * Whisper-recovered transcription of the actual TTS audio the caller
   * heard; in Layer 1 (`TextModeDriver`) it is the synthesized
   * confirmation/lookup string the driver was about to "speak". Graders
   * (perceived-completion, reprompt) consume this so they can judge the
   * caller-perceived turn directly instead of relying on the script's
   * `expected.spokenAnswerMatches` placeholder.
   */
  | {
      type: 'speech_outbound';
      /** Transcript of what the agent said this turn. */
      transcript: string;
      /** Zero-indexed turn within the session. */
      turnIndex: number;
      ts: number;
    }
  /** P2-1 / Section 5: a pre-rendered filler clip started playing. */
  | { type: 'filler_fired'; fillerText: string; ts: number }
  /** P2-1 / Section 5: an in-flight filler was cancelled by a real response. */
  | { type: 'filler_cancelled'; fillerText: string; ts: number }
  /** P2-3 / Section 5: the FSM fired a vertical-specific repair template. */
  | { type: 'repair_template_fired'; trigger: string; text: string; ts: number }
  // Section 4 — Escalation telemetry events (emitted from the escalation path)
  | EscalationStartedEvent
  | EscalationSummaryBuiltEvent
  | WhisperPlayedEvent
  | DispatcherAnsweredEvent
  | DispatcherNoAnswerEvent
  | EscalationOutcomeEvent;

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
  /**
   * Caller's phone number (Twilio `From`), set by the inbound adapter. Lets a
   * later gather turn create/resolve a CUSTOMER for an unknown caller who books
   * (the ask_caller → caller_known wire in the voice-turn processor).
   */
  callerPhone?: string;
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
  /**
   * U4 — B2B priority routing context, assembled at caller identification when
   * the matched customer is a business / property-manager account (parent +
   * sub-accounts + priority + occupied-property awareness). Adapter-side state
   * like `leadId`: the FSM never reads it. Consumed by triage / booking and
   * the live-call prompt assembly. Absent for residential callers and unknown
   * callers.
   */
  b2bAccountContext?: import('./b2b-account-context').B2bAccountContext;
  /**
   * P11-002 — resolved spoken language for this call ('en' | 'es').
   * Set by the inbound adapter from the tenant default (and customer
   * preference when known). Drives the greeting copy, `<Say>` Polly
   * voice, and the `<Gather>` STT locale on every TwiML build.
   */
  language?: 'en' | 'es';
  /**
   * Voice-parity — the tenant's opt-in language stack
   * (`tenant_settings.supported_languages`), resolved at session start. The
   * first-utterance language gate only switches a call to 'es' when 'es' is
   * present here. `undefined` means "not resolved" and is treated as
   * permissive (legacy behavior) so sessions created without a resolver wired
   * keep auto-detecting Spanish.
   */
  supportedLanguages?: ('en' | 'es')[];
  /**
   * P11-002 — resolved per-tenant TTS voice override for the session
   * language (settings.ttsVoiceEn/Es). When set, the `<Say voice>` uses
   * it instead of the default Polly voice for `language`. undefined =
   * use the default.
   */
  ttsVoice?: string;
  /**
   * RV-071 — in-flight owner voice-approval dialogue (readback awaiting
   * the explicit affirmative, clarification list, or challenge prompt).
   * Adapter-side state like `leadId`: the FSM never reads it. Carries no
   * secrets (the challenge value is re-read from settings at verify
   * time). Cleared whenever a turn resolves the dialogue.
   */
  pendingVoiceApproval?: import('../../tasks/proposal-approval-task').PendingVoiceApproval;
  /**
   * RV-071 — session-scoped voice-approval state (challenge fail counter
   * + lockout flag). Adapter-side like `pendingVoiceApproval` and lives
   * exactly as long as the session, but is NEVER cleared when a dialogue
   * resolves: three wrong challenge codes anywhere in the call must lock
   * money/irreversible approvals for the rest of the session, even across
   * cancelled-and-restarted dialogues. Merged (not replaced) from each
   * turn's `VoiceApprovalTurnResult.sessionState`.
   */
  voiceApprovalState?: import('../../tasks/proposal-approval-task').VoiceApprovalSessionState;
  /**
   * WS5 — in-flight tenant-catalog load, kicked off once at session
   * establishment (both voice transports) so in-call estimate grounding has
   * the active catalog in hand synchronously at quote time. Managed by
   * `ai/voice-turn/session-catalog.ts`; the FSM never reads it. Resolves to
   * `[]` on a read failure (never rejects). GC'd with the session.
   */
  catalogPreload?: Promise<import('../../../catalog/catalog-item').CatalogItem[]>;
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
  /** U3d — this store's replica identity for cross-instance self-origin dedup.
   *  Defaults to the per-process REPLICA_ID; tests override it to simulate
   *  multiple replicas within one process. */
  replicaId?: string;
  /**
   * U3d — cross-instance voice-event transport. When provided (and not the no-op
   * InProcess one), local events are mirrored to other replicas and remote
   * events are injected into this store's global + gateway sinks. Omitted ⇒ no
   * mirror (single-replica behavior unchanged).
   */
  transport?: VoiceEventTransport;
}

export class VoiceSessionStore {
  private readonly sessions = new Map<string, VoiceSession>();
  /**
   * Global listeners that receive every VoiceSessionEvent emitted by any
   * session. Registered via subscribeGlobal() and used by the escalation
   * SSE route to forward escalation_started events to connected dispatchers.
   */
  private readonly globalListeners = new Set<(evt: VoiceSessionEvent) => void>();
  /**
   * Hooks fired by create() each time a new session is added. Each
   * subscribeGlobal() subscriber registers one hook here so it can attach
   * a per-subscriber forwarder to the new session's emitter. This avoids
   * the anonymous-closure leak in the old create() implementation, where
   * a single shared closure iterated globalListeners at emit time and
   * could never be removed when a subscriber unsubscribed.
   */
  private readonly sessionCreatedListeners = new Set<(session: VoiceSession) => void>();
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
  private readonly transport?: VoiceEventTransport;
  private readonly replicaId: string;
  private readonly sweepHandle: ReturnType<typeof setInterval> | null;

  constructor(options: VoiceSessionStoreOptions = {}) {
    this.idleTtlMs = options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
    this.replicaId = options.replicaId ?? REPLICA_ID;
    const sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    const startInterval = options.startInterval ?? true;
    this.sweepHandle = startInterval
      ? setInterval(() => this.reapIdle(), sweepIntervalMs)
      : null;
    // Allow process to exit when this is the only handle pending.
    if (this.sweepHandle && typeof this.sweepHandle.unref === 'function') {
      this.sweepHandle.unref();
    }

    this.transport = options.transport;
    if (this.transport) {
      const transport = this.transport;
      // Mirror every local session event to the transport for cross-instance
      // fan-out; attach to each new session (and any already present).
      const attachMirror = (session: VoiceSession): void => {
        session.events.on(STORE_VOICE_EVENT_CHANNEL, (evt: VoiceSessionEvent) => {
          transport.publish({
            replicaId: this.replicaId,
            tenantId: session.tenantId,
            sessionId: session.id,
            callSid: session.callSid,
            event: evt,
          });
        });
      };
      this.sessionCreatedListeners.add(attachMirror);
      for (const session of this.sessions.values()) attachMirror(session);
      // Inject events published by OTHER replicas into this store's sinks.
      transport.subscribe((env) => {
        if (env.replicaId === this.replicaId) return; // drop our own (no double-fire)
        this.injectRemoteEvent(env);
      });
    }
  }

  /**
   * Inject an event published by another replica into the local sinks: the
   * global subscribers (escalation / supervisor wall via subscribeGlobal) and
   * the client WS gateway (so a dashboard watching this voice session on a
   * NON-owning replica still receives frames). Best-effort — one failing sink
   * must not starve the others, and the gateway publish is a no-op when disabled.
   */
  private injectRemoteEvent(env: VoiceEventEnvelope): void {
    for (const listener of this.globalListeners) {
      try {
        listener(env.event);
      } catch {
        /* one bad sink mustn't block the rest */
      }
    }
    void import('../../../ws/client-gateway')
      .then(({ publish }) => {
        publish(
          'voice',
          env.sessionId,
          {
            kind: 'voice.event',
            channel: 'voice',
            sessionId: env.sessionId,
            event: env.event.type,
            state: 'state' in env.event ? (env.event as { state?: string }).state : undefined,
            payload: env.event as unknown as Record<string, unknown>,
          },
          env.tenantId,
        );
      })
      .catch(() => {});
  }

  /** Create a new session and return it. */
  create(
    tenantId: string,
    channel: CallingAgentChannel,
    opts: {
      callSid?: string;
      conversationId?: string;
      repairTemplates?: ReadonlyArray<RepairTemplate>;
      escalationTriggers?: CallingAgentContext['escalationTriggers'];
      /** RV-070 — caller-ID matched an approver phone (owner / backup). */
      ownerSession?: boolean;
      /** Phase-2 Track A — tenant opted into extended owner intents. */
      extendedIntents?: boolean;
    } = {}
  ): VoiceSession {
    const id = uuidv4();
    const machine = new CallingAgentStateMachine({
      sessionId: id,
      tenantId,
      channel,
      callSid: opts.callSid,
      conversationId: opts.conversationId,
      ...(opts.repairTemplates ? { repairTemplates: opts.repairTemplates } : {}),
      ...(opts.escalationTriggers
        ? { escalationTriggers: opts.escalationTriggers }
        : {}),
      ...(opts.ownerSession ? { ownerSession: true } : {}),
      ...(opts.extendedIntents ? { extendedIntents: true } : {}),
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
    // Notify each subscribeGlobal() subscriber so it can attach its own
    // per-subscriber forwarder to the new session. This replaces the old
    // anonymous-closure approach (which iterated globalListeners at emit
    // time and could never be cleaned up on unsubscribe).
    for (const listener of this.sessionCreatedListeners) {
      listener(session);
    }
    return session;
  }

  /**
   * Subscribe to all VoiceSessionEvents emitted by any current or future
   * session. Used by the escalation SSE route. Returns an unsubscribe
   * function that cleanly removes all per-session forwarders registered by
   * this subscriber.
   *
   * Each subscriber gets its own named forwarder per session so that
   * unsubscribing removes only that subscriber's listeners — not listeners
   * from other concurrent subscribers.
   */
  subscribeGlobal(callback: (evt: VoiceSessionEvent) => void): () => void {
    this.globalListeners.add(callback);

    // Track per-session forwarders for THIS subscriber so we can detach
    // them on unsubscribe without touching other subscribers' forwarders.
    const sessionForwarders = new Map<string, (evt: VoiceSessionEvent) => void>();

    const attachToSession = (session: VoiceSession): void => {
      const forwarder = (evt: VoiceSessionEvent): void => callback(evt);
      sessionForwarders.set(session.id, forwarder);
      session.events.on(STORE_VOICE_EVENT_CHANNEL, forwarder);
    };

    // Attach to all currently-active sessions so reconnecting SSE clients
    // don't miss events on in-flight calls.
    for (const session of this.sessions.values()) {
      attachToSession(session);
    }

    // Register hook so future sessions created after this subscribe call
    // also get this subscriber's forwarder attached immediately.
    this.sessionCreatedListeners.add(attachToSession);

    return () => {
      this.globalListeners.delete(callback);
      this.sessionCreatedListeners.delete(attachToSession);
      for (const [sessionId, forwarder] of sessionForwarders) {
        const session = this.sessions.get(sessionId);
        if (session) {
          session.events.off(STORE_VOICE_EVENT_CHANNEL, forwarder);
        }
      }
      sessionForwarders.clear();
    };
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
   * Variant of findByCallSid that also returns sessions marked `ended`.
   * Used by post-call hooks (recording webhook → outcome stamp, transcript
   * ingestion) that legitimately need the FSM context AFTER the FSM has
   * terminated. The session is still in the map until idle reaping; the
   * `ended` flag only suppresses NEW dispatches, not lookup of historical
   * state.
   */
  findByCallSidIncludingEnded(callSid: string): VoiceSession | undefined {
    const id = this.callSidIndex.get(callSid);
    if (!id) return undefined;
    return this.sessions.get(id);
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
   * Number of LIVE (non-ended) sessions. Ended telephony sessions are retained
   * in the map for post-call lookups until the idle reaper removes them, so
   * `size()` overcounts for shutdown purposes. The SIGTERM drain waits on THIS
   * so a deploy with no live call tears down immediately instead of burning the
   * full DRAIN_TIMEOUT_MS on already-ended sessions. (Codex P2, PR #628.)
   */
  liveCount(): number {
    let n = 0;
    for (const session of this.sessions.values()) if (!session.ended) n += 1;
    return n;
  }

  /**
   * X10/PR#398 — supervisor wall discovery. Returns non-ended sessions
   * for the given tenant so the wall can seed its local state and send
   * per-session WS `subscribe` frames (the gateway rejects voice subs
   * without a `targetId` — see `authorizeSubscribe` in `ws/client-gateway`).
   */
  listActiveByTenant(tenantId: string): VoiceSession[] {
    const out: VoiceSession[] = [];
    for (const session of this.sessions.values()) {
      if (session.tenantId === tenantId && !session.ended) out.push(session);
    }
    return out;
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
        // emit() runs listeners synchronously on this timer's stack — with
        // no request context around it, a throwing listener (SSE write to a
        // half-closed socket, transport publish) would escape the interval
        // callback as an uncaughtException and kill the process. One bad
        // sink must not stop the sweep or take down other tenants' calls.
        try {
          session.events.emit('voice-event', {
            type: 'ended',
            reason: 'idle_timeout',
          } satisfies VoiceSessionEvent);
        } catch (err) {
          process.stderr.write(
            `voice-session reap listener failed: ${err instanceof Error ? err.message : String(err)}\n`
          );
        }
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
    void this.transport?.close().catch(() => {});
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
