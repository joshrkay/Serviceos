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
import { CallingAgentStateMachine, rewriteStrings } from './state-machine';
import type {
  CallingAgentChannel,
  CallingAgentContext,
  CallingAgentState,
  SideEffect,
} from './types';
import type { RepairTemplate } from '../../../verticals/registry';
import type { TurnTrace } from './turn-trace';
import { SessionCostTracker, DEFAULT_INAPP_CAPS, DEFAULT_TELEPHONY_CAPS } from '../../skills/session-cost-tracker';
import type { CallOutcome } from '../../../voice/voice-service';
import type {
  CallTranscriptTurnRepository,
  CallTurnSpeaker,
  CallTurnTransport,
  RedactCardNumberTurnsInput,
  ReplyUnackedReason,
} from '../../../voice/call-transcript-turn';
import { voiceReplyStampLostTotal } from '../../../monitoring/metrics';
import type { ResolvedApprover } from '../../../proposals/approver-identity';
import {
  agentLinesBefore,
  CARD_NUMBER_PLACEHOLDER,
  cardSplitWindow,
  redactCardFragments,
  redactCardNumbersAcrossTurns,
} from '../../privacy/pan-redact';
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

/**
 * U1 — how many of a session's most recent caller turns keep their reply
 * timing anchors and retained persist promise. Back-to-back finals queue
 * behind the per-session lock, so a handful covers every reply still in flight.
 */
const RETAINED_CALLER_TURNS = 4;

/** How an agent line starts in {@link VoiceSession.transcript} (`appendTranscript`). */
const AGENT_LINE = 'agent: ';

/** One entry of {@link VoiceSession.recentCallerTurns}. */
interface RecentCallerTurn {
  /** Its index in the session transcript (and its mid-call row key). */
  turnIndex: number;
  /** The text stored for it; rewritten in place when a split card is found. */
  text: string;
  /** Epoch ms it was said (the entry's `ts`, else append time). */
  at: number;
  /** Its `recordTurn` promise (the row id; undefined when not persisted). */
  row?: Promise<string | undefined>;
}

/**
 * PRIV-3 — an earlier caller turn a cross-turn card rewrite changed: where it
 * is, its text as it was taken, as it now reads, and the spans that became the
 * marker (in the order said).
 */
interface CapturedTextRewrite {
  turnIndex: number;
  from: string;
  to: string;
  fragments: readonly string[];
}

/**
 * PRIV-3 — one stored row a cross-turn card rewrite changed: a caller turn
 * that held part of the card, or an agent line that repeated a part of it.
 */
interface RewrittenTurn {
  turnIndex: number;
  speaker: CallTurnSpeaker;
  text: string;
  /** Its `recordTurn` promise (the row id; undefined when not persisted). */
  row?: Promise<string | undefined>;
}

/**
 * PRIV-3 — the words a turn already handed on before a later turn showed
 * they held part of a card number: the FSM context (`lastUtterance`, which
 * the confirm turn's proposal is drafted from, the classifier's entities, a
 * pending reference), the requests the session holds for an answer (identity
 * check, service-area check, a rebook offer and its entities) and the in-app
 * duplicate-turn record (the operator's words and the line spoken back).
 * Each is rewritten as the transcript was: text that is a whole earlier turn
 * becomes its rewritten text, and any number in it that reads a part of the
 * card that became the marker becomes the marker (`redactCardFragments`:
 * whole numbers only, in whatever form the classifier wrote them, so a ZIP
 * that merely holds the same digits is left alone).
 */
function rewriteCapturedText(session: VoiceSession, rewrites: readonly CapturedTextRewrite[]): void {
  const fragments = rewrites.flatMap((r) => r.fragments);
  const rewrite = (text: string): string =>
    redactCardFragments(rewrites.find((r) => r.from === text)?.to ?? text, fragments);
  session.machine.rewriteCapturedText(rewrite);
  if (session.callerIdentityCheck) {
    session.callerIdentityCheck.heldUtterance = rewrite(session.callerIdentityCheck.heldUtterance);
  }
  if (session.serviceAreaCheck) {
    session.serviceAreaCheck.heldUtterance = rewrite(session.serviceAreaCheck.heldUtterance);
  }
  if (session.rebookOffer) {
    session.rebookOffer.heldUtterance = rewrite(session.rebookOffer.heldUtterance);
    session.rebookOffer.entities = rewriteStrings(session.rebookOffer.entities, rewrite);
  }
  if (session.lastOperatorTurn) {
    session.lastOperatorTurn.normalizedText = rewrite(session.lastOperatorTurn.normalizedText);
    if (session.lastOperatorTurn.lastSpoken !== undefined) {
      session.lastOperatorTurn.lastSpoken = rewrite(session.lastOperatorTurn.lastSpoken);
    }
  }
}

/** Fold retained stamps into one, the first stamp for a field winning (as the repository's COALESCE does). */
function mergeReplyStamps(stamps: ReplyAudioStampFields[]): ReplyAudioStampFields {
  const merged: ReplyAudioStampFields = {};
  for (const stamp of stamps) {
    for (const [field, value] of Object.entries(stamp) as Array<[keyof ReplyAudioStampFields, never]>) {
      if (value !== undefined && merged[field] === undefined) merged[field] = value;
    }
  }
  return merged;
}

export type VoiceSessionEvent =
  /**
   * FSM transitioned to a new state.
   *
   * R1 — `trace` carries the same per-turn action-path summary the HTTP
   * response does, so an SSE subscriber can see how far the turn got (and
   * what stopped it) without re-deriving it from `sideEffects`. Optional
   * because the telephony transports emit this event too and do not build
   * one; the in-app adapter always sets it.
   */
  | {
      type: 'transition';
      state: CallingAgentState;
      event: string;
      sideEffects: SideEffect[];
      trace?: TurnTrace;
    }
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
  /**
   * #847: the `en_route` DIRECT status act ran on a live surface. Not a
   * `lookup_executed` — "on my way" mutates (audit + customer ETA text), so
   * dashboards must not count it among read-only lookups. Fires for EVERY
   * outcome, same discipline as lookup_executed: a dead branch is a metric,
   * not an audit finding.
   */
  | {
      type: 'en_route_executed';
      outcome: 'sent' | 'no_appointment' | 'ambiguous' | 'refused' | 'unavailable';
      durationMs: number;
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
      cause: 'hangup' | 'cost_cap' | 'cap_exceeded' | 'compliance_blocked' | 'completed' | 'life_safety_e1';
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
  /**
   * U1 — timing of the caller utterance this line records. Carried WITH the
   * append (never queued separately) because caller finals do not append in
   * arrival order: an explicit language-switch final can wait behind the
   * session lock while a later final's turn appends first. Ignored on agent
   * lines.
   */
  timing?: CallerTurnTiming;
}

/**
 * PRIV-3 — what {@link VoiceSessionStore.appendTranscript} stored for a turn.
 * A caller turn that completes a card number the caller split across turns is
 * stored with its part of the card replaced by the marker, and so are the
 * earlier turns that held the rest: the transport reads the turn on as
 * `text`, never as the words it appended.
 */
export interface AppendedTranscriptTurn {
  /** The turn's text as stored. */
  text: string;
  /**
   * Transcript indexes of the earlier lines the append rewrote (oldest
   * first): the caller turns that held the card's other parts, and the agent
   * lines that repeated one of them.
   */
  rewrittenTurnIndexes: number[];
}

/**
 * U1 — timing the transport knows about the caller's utterance at the moment
 * its text is appended: when the recogniser finalised it and, on the realtime
 * path only, when the caller's last word ended (Deepgram word timing anchored
 * to wall clock). Rides on the caller line's {@link TranscriptEntry} so each
 * row is stamped with its own utterance's timing.
 */
export interface CallerTurnTiming {
  transport: CallTurnTransport;
  /**
   * Unique per accepted final (the realtime adapter sets it). Kept with the
   * row's reply anchor so a reply resolves ITS row by key: STT-final instants
   * are millisecond-resolution and two finals can share one.
   */
  turnKey?: string;
  sttFinalAt: Date;
  lastWordAt?: Date;
}

/**
 * U1 — what the adapter learned about a reply's audio. Every field is a
 * stamp the repository COALESCEs onto the caller turn's row, so a repeated or
 * later stamp never overwrites the first.
 */
export interface ReplyAudioStampFields {
  firstAudibleAt?: Date;
  firstAudioEnqueuedAt?: Date;
  firstAudioAt?: Date;
  replyGapMs?: number;
  replyUnackedReason?: ReplyUnackedReason;
}

/**
 * A stamp addressed by the caller turn's unique key (see
 * {@link CallerTurnTiming.turnKey}), not by transcript index: the adapter can
 * learn something about a reply before the caller row it answers is appended
 * (a final queued behind an earlier turn), so the store resolves the row —
 * immediately, or once it appears.
 */
export interface ReplyAudioStamp extends ReplyAudioStampFields {
  turnKey: string;
}

export interface VoiceSession {
  id: string;
  tenantId: string;
  channel: CallingAgentChannel;
  /**
   * #1737 — the `voice_sessions.channel` value to persist when it is not the
   * one `channel` implies. The web chat widget drives the caller-facing
   * (`telephony`) FSM but must be stored, and kept out of phone-minute
   * accounting, as `webchat`.
   */
  persistChannel?: 'webchat';
  /** Twilio CallSid for telephony sessions; undefined for in-app. */
  callSid?: string;
  /** Bound by the authenticated inbound webhook; never taken from a WS frame. */
  twilioAccountSid?: string;
  /**
   * Caller's phone number (Twilio `From`), set by the inbound adapter. Lets a
   * later gather turn create/resolve a CUSTOMER for an unknown caller who books
   * (the ask_caller → caller_known wire in the voice-turn processor).
   */
  callerPhone?: string;
  /**
   * #1540 §3 — true when this call's ask_caller turn CREATED the caller's
   * customer record from their phone number. Such a caller is not "already a
   * customer" — their sign-up request is the record's first real content.
   */
  callerCreatedThisCall?: boolean;
  /**
   * #1582 (owner decision 2026-10-02) — this new caller's customer record is
   * HELD: the tenant has a service area, so the record is created only once
   * the request is known not to be an out-of-area booking (#1567). An
   * out-of-area caller is kept as a lead only and this stays unset.
   */
  callerCreateHeld?: { callerPhone: string };
  /**
   * #1331 (owner decision 2026-10-01) — the caller-ID-identified caller said
   * a name that does not confidently match the account, and was asked "is
   * this <name on the account>?". Holds the request they made until they
   * answer (caller-identity-check.ts).
   */
  callerIdentityCheck?: { heldUtterance: string; accountName: string; reasks: number };
  /**
   * #1331 — the caller's answer to that check (or a confident name match):
   * 'confirmed' never asks again; 'rejected' unbound the account for this call.
   */
  callerIdentity?: 'confirmed' | 'rejected';
  /**
   * #1567 — a new caller on a booking was asked for the service-address ZIP
   * (service-area-gate.ts). Holds the booking request until they answer.
   */
  serviceAreaCheck?: { heldUtterance: string; reasks: number };
  /**
   * #1567 — this call's service-area answer: 'out_of_area' declines every
   * later booking on the call; 'in_area' / 'unknown' (no ZIP after the
   * re-ask) never ask again.
   */
  serviceAreaVerdict?: 'in_area' | 'out_of_area' | 'unknown';
  /**
   * #1600 (2) — how many times each WRITE intent (one that drafts a proposal)
   * has been classified on this S1 call, keyed by intent type. The fifth
   * repeat of one intent hands the call to a person
   * (create-voice-turn-processor.ts `repeatedWriteIntentHandoff`).
   */
  writeIntentRepeats?: Record<string, number>;
  /**
   * #1600 (3) — the caller referred to a CANCELLED appointment of theirs and
   * was offered a new booking ("would you like to book a new one?"). Holds
   * the request's words, the booking details already given (the new day
   * anchored to the cancelled visit's time) and the classifier's confidence
   * for that request until they answer
   * (create-voice-turn-processor.ts `handlePendingRebookOffer`).
   */
  rebookOffer?: {
    heldUtterance: string;
    cancelledAppointmentId: string;
    entities: Record<string, unknown>;
    confidence: number;
  };
  /**
   * #1223 — Twilio's STIR/SHAKEN verdict (`StirVerstat`) from the inbound
   * webhook, verbatim; absent when Twilio sent none. Owner-line authority
   * requires full A-attestation (`telephony/stir-attestation.ts`).
   */
  stirVerstat?: string;
  /**
   * #1223 — the caller-ID matched an approver (owner / backup supervisor) but
   * the call was NOT A-attested, so it runs as an untrusted caller. Drives
   * the spoken "use the app for owner actions" notice at establishment.
   */
  ownerLineUnverified?: boolean;
  /** Linked conversation row for persisting transcript / proposals. */
  conversationId?: string;
  machine: CallingAgentStateMachine;
  costTracker: SessionCostTracker;
  /** Raw 16kHz PCM bytes submitted to streaming STT for provider billing. */
  sttAudioBytes: number;
  /** Text characters submitted to TTS, counted once per requested utterance. */
  ttsCharacters: number;
  /** Set by the WebSocket transport so Twilio Media Streams cost is included. */
  mediaStreamsUsed: boolean;
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
   * #866 — the tenant user this call is authorised AS, resolved ONCE at
   * session establishment from the caller-ID (`telephony/phone-actor.ts`)
   * and never from utterance content. A Clerk subject when the user has
   * one, else the users row id — both are accepted by the shared role
   * resolver. Absent for customers and unrecognised numbers: permission-
   * gated lookups then refuse honestly. Session-level (not FSM context) on
   * purpose: the transition table must stay inert to it.
   *
   * Only the telephony establishment core populates this field —
   * `TwilioGatherAdapter.establishInboundSession`, shared by BOTH phone
   * transports, so a Media Streams session carries it today just as a Gather
   * session does (pinned in test/telephony/owner-session.test.ts). What Media
   * Streams lacks until #860 step 2 is the DISPATCH — `speechTurn` does not yet
   * call `answerPhoneLookup`; step 2 adds that call and nothing about the actor.
   *
   * The IN-APP adapter stamps it too (`InAppVoiceAdapter.startSession`), from
   * the authenticated operator the route passes — no caller-ID inference is
   * involved or possible there, and the shared lookup RBAC gate needs the
   * same subject on every surface. The voice-quality drivers
   * (`text-mode-driver`, `audio-mode-driver`) create sessions outside both
   * cores; `text-mode-driver` sets a synthetic owner actor for owner-line
   * scripts and otherwise leaves it undefined.
   */
  actorUserId?: string;
  /**
   * B1 — who this owner line approves AS (`resolveApproverRole`): the owner
   * for the owner phone, the backup supervisor as their own role and user.
   * Stamped by the telephony establishment core
   * (`TwilioGatherAdapter.establishInboundSession`, both transports) together
   * with `ownerSession`, from the caller-ID — never from utterance content.
   * B1 follow-up — it marks the line as caller-ID-established: the turn
   * processor re-resolves the approver from that caller-ID at every voice
   * approve / reject / edit (`currentApprovalLine`), so a backup demoted,
   * deactivated or replaced mid-call acts as who they are now — and (B3-1)
   * at the start of every turn, so a line that no longer resolves keeps no
   * owner-line privilege that turn (`refreshOwnerLine`). Absent on a
   * session whose owner authority came from an authenticated owner (in-app)
   * or a harness fixture: that is the owner. B4-2 — `userRowId` (a backup's
   * users row; none for the owner phone) is who the line was picked up as,
   * and what that re-check compares: a backup who links a login mid-call
   * changes `userId`, not who they are.
   */
  ownerLineApprover?: Pick<ResolvedApprover, 'role' | 'userId' | 'userRowId'>;
  /**
   * B3-1 — what the caller-ID-established owner line was granted at pick-up
   * besides `ownerSession`: the extended owner lookups and the phone actor
   * (`actorUserId`, the subject every owner lookup is authorised by). The
   * turn processor's per-turn re-check (`refreshOwnerLine`) records it the
   * first time it runs, drops all of it for a turn whose re-check no longer
   * resolves the line (or resolves it to someone other than the person
   * `ownerLineApprover.userRowId` names), and restores it on a later turn
   * that resolves it to that same person again. Absent on a session that
   * carries no `ownerLineApprover`.
   */
  ownerLineGrant?: { extendedIntents: boolean; actorUserId?: string };
  /**
   * B4-4 — what this turn's owner-line re-check (`refreshOwnerLine`, run first
   * by every turn: `speechTurn`, the Gather loop, the silence turn) resolved,
   * so the turn's approve / reject / edit step reuses it instead of a second
   * settings + users read. That step takes (clears) it; a step that finds
   * none re-checks itself. `approver: null` — the line did not resolve this
   * turn (a lookup error included), so the step refuses: fail closed.
   */
  ownerLineThisTurn?: { approver: ResolvedApprover | null };
  /**
   * True once the recording disclosure has actually been emitted to the caller
   * on this call (set by `bootstrapCallEstablishment`, which is the only
   * caller of `discloseRecording`). Any path that resumes or re-arms audio
   * capture on a live call — notably the realtime→Gather degrade — must speak
   * the disclosure first when this is falsy, rather than assume an earlier
   * turn covered it. The realtime transport can degrade BEFORE establishment
   * ever runs (e.g. the STT socket fails to open), leaving a session that
   * exists but has heard nothing.
   */
  recordingDisclosed?: boolean;
  /**
   * PRIV-4 — true once this call has evidence the caller HEARD the
   * virtual-assistant notice (the greeting reached its point of evidence:
   * Gather's TwiML was built, or the stream's greeting turn played to
   * completion), or a fallback document spoke it. Unlike `recordingDisclosed`
   * (latched when the greeting is merely queued), a realtime→Gather degrade
   * mid-greeting leaves this false, so the fallback speaks the notice itself.
   */
  assistantNoticeHeard?: boolean;
  /**
   * PRIV-4 — the full greeting (virtual-assistant notice and recording notice
   * included) `bootstrapCallEstablishment` rendered for this call. A /voice
   * webhook retry replays it: Twilio discarded the first response, so the
   * retry's document is the only greeting the caller hears.
   */
  greetingText?: string;
  /**
   * Set when the caller objected to being recorded. The Twilio recording is
   * paused via the REST API, but that only covers `<Start><Record>` — the
   * realtime transport's capture is the STT socket, which no REST call
   * touches. The media-streams frame gate reads this so "stop recording"
   * actually stops capture on both transports rather than only on the one
   * that happens to have a Twilio recording attached.
   */
  captureRevoked?: boolean;
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
   * U1 — the timing anchors of the last few persisted caller turns (oldest
   * first, bounded to {@link RETAINED_CALLER_TURNS}), so the reply to each can
   * be measured against ITS OWN row even when a newer turn has already been
   * persisted: transcript index plus the last-word / STT-final instants stored
   * with it.
   */
  replyTimings: Array<{ turnIndex: number; turnKey?: string; lastWordAt?: Date; sttFinalAt: Date }>;
  /**
   * U1 — the `recordTurn` promise of the latest caller turns, keyed by
   * transcript index and RETAINED after it settles so a reply stamp can chain
   * behind the INSERT whether the insert is still pending or long resolved.
   * Resolves to the row's primary key (undefined when the insert failed), which
   * is the stable identity for the reply stamp: `attachRecording` renumbers
   * `turn_index` at end of call, so the index alone can miss a late stamp.
   * Never rejects. Holds the last {@link RETAINED_CALLER_TURNS} entries (older
   * ones are dropped as newer caller turns are persisted) and is cleared with
   * the session.
   */
  pendingTurnPersist: Map<number, Promise<string | undefined>>;
  /**
   * U1 — reply stamps that arrived before their caller row was appended (a
   * final queued behind an earlier turn can have its filler acked first),
   * keyed by the turn's unique key and flushed, in order, when `persistTurn`
   * records the row carrying that key. Holds at most the last
   * {@link RETAINED_CALLER_TURNS} keys (older ones are dropped with a warning)
   * and is cleared with the session.
   */
  pendingReplyStamps: Map<string, ReplyAudioStampFields[]>;
  /**
   * PRIV-3 — the window a card number split across caller turns is looked
   * for in: the last few non-empty caller turns (`cardSplitWindow`), oldest
   * first, with the one said just before them (read only for a mention of the
   * card). See `appendTranscript`.
   */
  recentCallerTurns: RecentCallerTurn[];
  /**
   * PRIV-3 — the agent lines said since the oldest of `recentCallerTurns`
   * (their transcript index and row), oldest first: a card rewrite also
   * rewrites one that repeated a part of the card the caller had said before
   * it (the confirm readback). See `appendTranscript`.
   */
  recentAgentTurns: Array<{ turnIndex: number; row?: Promise<string | undefined> }>;
  /**
   * PRIV-3 — tail of this session's cross-turn card-number rewrites of the
   * stored rows, chained so they land in the order they were made (a later
   * rewrite of a row starts from the earlier one's text). Never rejects.
   */
  cardRedactionWrites: Promise<void>;
  /**
   * PRIV-3 — cross-turn rewrites of the stored rows that did not land (each
   * one rewrite's rows, by id, with their already-redacted text). The
   * completing turn's row was stored rewritten, so the fragments left in the
   * earlier rows no longer read as a card: nothing but this list can say what
   * they must become. The recording transcript hook writes them before the
   * call is ingested.
   */
  unwrittenCardRedactions: Array<RedactCardNumberTurnsInput['turns']>;
  /**
   * P11-002 — resolved per-tenant TTS voice override for the session
   * language (settings.ttsVoiceEn/Es). When set, the `<Say voice>` uses
   * it instead of the default Polly voice for `language`. undefined =
   * use the default.
   */
  ttsVoice?: string;
  /**
   * #846 — per-session count of honored mid-session language switches on
   * the transports that have no adapter-side call state of their own: the
   * Gather adapter and the in-app voice-session adapter. Both cap it at
   * MAX_LANGUAGE_SWITCHES_PER_CALL (`ai/orchestration/language-detector.ts`),
   * the same policy the media-streams adapter enforces — its counter lives
   * in adapter state next to the Deepgram socket, so it does not ride the
   * session. Adapter-side like `leadId`: the FSM never reads it.
   */
  languageSwitchCount?: number;
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
   * WS18 — in-flight on-call SMS consent capture. Set when the close flow asks
   * the caller for permission to text the quote + booking link; the NEXT turn's
   * answer is evaluated by strict confirmIntent (ambiguous → no). Adapter-side
   * state like `pendingVoiceApproval` (the FSM never reads it); consumed and
   * cleared at the top of the speech turn. Carries no secrets.
   *
   * WS2 — `close` is set when the capture was initiated by the close flow: a
   * grant then continues into hold placement + owner-approval chain staging
   * instead of the plain acknowledgment. `strictConfirmed` records that the
   * authoritative confirmIntent gate already passed on the affirmative turn (an
   * input to evaluateAutonomousCloseLane).
   */
  pendingConsentCapture?: {
    customerId: string;
    phone: string;
    close?: { proposalId: string; strictConfirmed: boolean };
  };
  /**
   * WS2 — terminal close-flow state for this session. 'fallback' after the
   * owner-approval chain was staged (nothing is confirmed until the owner
   * taps approve). Guards a repeated "yes, book it" from re-staging the chain /
   * re-texting the owner.
   */
  closeState?: 'fallback';
  /**
   * WS5 — in-flight tenant-catalog load, kicked off once at session
   * establishment (both voice transports) so in-call estimate grounding has
   * the active catalog in hand synchronously at quote time. Managed by
   * `ai/voice-turn/session-catalog.ts`; the FSM never reads it. Resolves to
   * `[]` on a read failure (never rejects). GC'd with the session.
   */
  catalogPreload?: Promise<import('../../../catalog/catalog-item').CatalogItem[]>;
  /**
   * Consecutive AI infrastructure failures (quota/breaker/provider) on
   * classify. First transient failure gets a hold-line retry; the next
   * escalates. Cleared on a successful classify. Adapter-side; FSM never reads it.
   */
  aiInfraRetryCount?: number;
  /**
   * R2 — the previous operator turn on this session, recorded at the END of
   * every turn (including the deterministic recovery turns). The duplicate
   * detector compares the incoming utterance against `normalizedText`, the
   * arrival gap against `at`, and the CURRENT FSM state against `stateAfter`
   * — "the state is unchanged since that turn" means the FSM is still where
   * the last turn left it, which is what makes a re-send a re-send rather
   * than a legitimate repeat later in the dialogue.
   *
   * `lastSpoken` is the rendered line the operator already heard, re-spoken
   * verbatim on a duplicate so a client retry is idempotent end to end.
   * Adapter-side state like `leadId`: the FSM never reads it, and it carries
   * only the operator's own words.
   */
  lastOperatorTurn?: {
    normalizedText: string;
    at: number;
    stateBefore: CallingAgentState;
    stateAfter: CallingAgentState;
    lastSpoken?: string;
  };
  /**
   * R2 — consecutive filler / mic-check turns answered by the deterministic
   * noise reprompt. Reset by any turn that carried a real request. Bounds the
   * free reprompt so a genuinely dead microphone still falls through to the
   * classifier and the FSM's escalation budget. Adapter-side; FSM never reads it.
   */
  noiseTurnCount?: number;
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
  /**
   * #8b / H1 — epoch ms at which a PERSON accepted the hand-off (pressed 1 on
   * the whisper screen). Set while the bridged call is still live — long
   * before /dial-result stamps `terminalReason = 'transferred'` at its end —
   * so the emergency page ladder stops paging a dispatcher who is already on
   * the call. Never set by a mere pickup: a carrier voicemail "answers" too.
   */
  transferAnsweredAt?: number;
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
  /**
   * U8 (R8) — mid-call transcript persistence. When provided, every
   * `appendTranscript` on a session with a `callSid` is also written to
   * call_transcript_turns keyed by call SID + session id (fire-and-forget).
   * Omitted ⇒ in-memory only (tests, in-app-only deployments).
   */
  callTranscriptTurnRepo?: CallTranscriptTurnRepoPort;
}

/** The slice of the repository the store writes through. */
type CallTranscriptTurnRepoPort = Pick<
  CallTranscriptTurnRepository,
  'recordTurn' | 'markReplyAudio' | 'redactCardNumberTurns'
>;

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
  private readonly callTranscriptTurnRepo?: CallTranscriptTurnRepoPort;

  constructor(options: VoiceSessionStoreOptions = {}) {
    this.idleTtlMs = options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
    this.callTranscriptTurnRepo = options.callTranscriptTurnRepo;
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
      /** Phase-2 Track A — tenant opted into extended owner lookups. */
      extendedIntents?: boolean;
      /** Customer protection (complaint/negotiation) — always on for telephony. */
      customerProtectionIntents?: boolean;
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
      ...(opts.customerProtectionIntents ? { customerProtectionIntents: true } : {}),
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
      sttAudioBytes: 0,
      ttsCharacters: 0,
      mediaStreamsUsed: false,
      pendingTurnPersist: new Map(),
      pendingReplyStamps: new Map(),
      replyTimings: [],
      recentCallerTurns: [],
      recentAgentTurns: [],
      cardRedactionWrites: Promise.resolve(),
      unwrittenCardRedactions: [],
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

  /**
   * Append a turn to the session transcript as a formatted string. No-op if
   * session unknown.
   *
   * U8 (R8): when a `callTranscriptTurnRepo` is injected and the session is
   * a Twilio call (has a `callSid`), the turn is also persisted keyed by
   * `(tenantId, callSid, sessionId, turnIndex)` so the transcript survives a
   * restart / reap before the recording webhook fires. The index is the
   * transcript position at append time — the same index the recording hook
   * derives when it has to fall back to this in-memory array. Fire-and-forget:
   * a failing write is logged and never reaches the call path.
   *
   * PRIV-3 — a caller who pauses mid-card leaves turns that each hold fewer
   * than 13 digits, which the per-turn scrub (`callerTranscriptText`) cannot
   * see. Every caller turn is therefore also read together with the caller
   * turns just before it (`cardSplitWindow`: five turns, one minute); when a
   * Luhn-valid card spans them, each
   * contributing span becomes the marker: in the in-memory transcript at once
   * (so no later prompt, proposal or summary built from it carries the card),
   * in the new turn's row as it is inserted, and in the earlier rows by one
   * transaction chained behind their inserts. The agent's lines between those
   * turns that repeated a part of the card the caller had said before them
   * (the confirm readback renders what the classifier took from the turn)
   * are rewritten the same way, in memory and in that transaction. The words
   * already taken from the earlier turns (the FSM context's `lastUtterance`
   * and extracted entities, a held request) are rewritten too, and the turn's
   * own text is returned: the transport reads the rest of the turn
   * (classification, the FSM, the safety scan, the task handlers) on as that,
   * never as the words it appended.
   */
  appendTranscript(sessionId: string, entry: TranscriptEntry): AppendedTranscriptTurn {
    const session = this.sessions.get(sessionId);
    if (!session) return { text: entry.text, rewrittenTurnIndexes: [] };
    const turnIndex = session.transcript.length;
    const split = entry.speaker === 'caller' ? this.redactCardSplitAcrossTurns(session, turnIndex, entry) : null;
    const line = split ? { ...entry, text: split.text } : entry;
    session.transcript.push(`${line.speaker}: ${line.text}`);
    session.lastActivityAt = new Date();
    const row = this.persistTurn(session, turnIndex, line);
    const tracked = session.recentCallerTurns[session.recentCallerTurns.length - 1];
    if (line.speaker === 'caller') {
      if (tracked?.turnIndex === turnIndex) tracked.row = row;
    } else if (session.recentCallerTurns.length > 0) {
      session.recentAgentTurns.push({ turnIndex, row });
    }
    if (split) {
      const self = split.rewritten.find((t) => t.turnIndex === turnIndex);
      if (self) self.row = row;
      this.persistCardRedaction(session, split.rewritten);
    }
    return {
      text: line.text,
      rewrittenTurnIndexes: (split?.rewritten ?? []).map((t) => t.turnIndex).filter((i) => i !== turnIndex),
    };
  }

  /**
   * PRIV-3 — slide the caller-turn window forward to the new turn and look
   * for a card number spanning it. On a hit the earlier turns' lines, and the
   * agent's lines between them that repeated a part of the card, are
   * rewritten in memory here; returns the new turn's text and every line
   * whose stored text changed (the new one included, oldest first), else null.
   */
  private redactCardSplitAcrossTurns(
    session: VoiceSession,
    turnIndex: number,
    entry: TranscriptEntry,
  ): { text: string; rewritten: RewrittenTurn[] } | null {
    const at = entry.ts ?? Date.now();
    const { window: earlier, before } = cardSplitWindow(session.recentCallerTurns, at);
    const kept = before ? [before] : [];
    // An empty utterance holds no digits and is never persisted.
    if (entry.text.trim().length === 0) {
      session.recentCallerTurns = [...kept, ...earlier];
      this.forgetAgentTurnsBefore(session);
      return null;
    }
    const current: RecentCallerTurn = { turnIndex, text: entry.text, at };
    const window = [...earlier, current];
    session.recentCallerTurns = [...kept, ...window];
    this.forgetAgentTurnsBefore(session);
    if (earlier.length === 0) return null;
    // The agent's lines right before each turn of the window, and the
    // caller's turn before it: a card read group by group, one per turn, must
    // be mentioned in them or in its own turns. Only the transcript from the
    // agent's lines before the window's first turn is read.
    let from = window[0].turnIndex;
    while (from > 0 && session.transcript[from - 1].startsWith(AGENT_LINE)) from--;
    const agentLines = agentLinesBefore(
      session.transcript
        .slice(from)
        .map((line) =>
          line.startsWith(AGENT_LINE) ? { speaker: 'agent', text: line.slice(AGENT_LINE.length) } : { speaker: 'caller', text: '' },
        ),
      window.map((t) => t.turnIndex - from),
    );
    const fragments = new Map<number, string[]>();
    const texts = redactCardNumbersAcrossTurns(
      window.map((t) => t.text),
      CARD_NUMBER_PLACEHOLDER,
      { agentLines, ...(before ? { callerTurnBefore: before.text } : {}) },
      (k, matched) => fragments.set(k, [...(fragments.get(k) ?? []), matched]),
    );
    if (!texts) return null;
    const rewritten: RewrittenTurn[] = [];
    const captured: CapturedTextRewrite[] = [];
    window.forEach((turn, k) => {
      if (texts[k] === turn.text) return;
      if (turn !== current) {
        captured.push({ turnIndex: turn.turnIndex, from: turn.text, to: texts[k], fragments: fragments.get(k) ?? [] });
        session.transcript[turn.turnIndex] = `caller: ${texts[k]}`;
      }
      turn.text = texts[k];
      rewritten.push({ turnIndex: turn.turnIndex, speaker: 'caller', text: turn.text, row: turn.row });
    });
    // The agent's lines between the card's turns (an in-app adapter writes its
    // own straight into the transcript), each against the parts the caller had
    // said before it.
    const agentRows = new Map(session.recentAgentTurns.map((t) => [t.turnIndex, t.row]));
    for (let i = (captured[0]?.turnIndex ?? turnIndex) + 1; i < turnIndex; i++) {
      const line = session.transcript[i];
      if (!line.startsWith(AGENT_LINE)) continue;
      const said = captured.filter((c) => c.turnIndex < i).flatMap((c) => c.fragments);
      const text = line.slice(AGENT_LINE.length);
      const next = redactCardFragments(text, said);
      if (next === text) continue;
      session.transcript[i] = `${AGENT_LINE}${next}`;
      rewritten.push({ turnIndex: i, speaker: 'agent', text: next, row: agentRows.get(i) });
    }
    if (captured.length > 0) rewriteCapturedText(session, captured);
    rewritten.sort((a, b) => a.turnIndex - b.turnIndex);
    return rewritten.length > 0 ? { text: current.text, rewritten } : null;
  }

  /** PRIV-3 — drop the agent lines said before the oldest caller turn still in the window. */
  private forgetAgentTurnsBefore(session: VoiceSession): void {
    const oldest = session.recentCallerTurns[0]?.turnIndex ?? Infinity;
    while (session.recentAgentTurns.length > 0 && session.recentAgentTurns[0].turnIndex < oldest) {
      session.recentAgentTurns.shift();
    }
  }

  /**
   * PRIV-3 — the stored half of a cross-turn rewrite: one repository
   * transaction for every contributing row, chained behind those rows'
   * inserts (and behind any earlier rewrite of this session). Fire-and-forget
   * like `persistTurn`: a failure is logged, kept on the session for the
   * recording hook to write (`unwrittenCardRedactions`), and never reaches the
   * call path.
   */
  private persistCardRedaction(session: VoiceSession, rewritten: RewrittenTurn[]): void {
    const repo = this.callTranscriptTurnRepo;
    const { callSid } = session;
    if (!repo || !callSid) return; // in-app: the running transcript is rewritten from memory
    const turns = rewritten.map((t) => ({ ...t, text: t.text.trim() }));
    session.cardRedactionWrites = session.cardRedactionWrites
      .then(() => Promise.all(turns.map((t) => t.row ?? Promise.resolve(undefined))))
      .then(async (ids) => {
        const rows = turns.map((t, k) => ({
          ...(ids[k] ? { id: ids[k] } : {}),
          turnIndex: t.turnIndex,
          // Absent for a caller row (the repository's default).
          ...(t.speaker === 'agent' ? { speaker: t.speaker } : {}),
          text: t.text,
        }));
        try {
          await repo.redactCardNumberTurns({
            tenantId: session.tenantId,
            callSid,
            sessionId: session.id,
            actorId: 'voice-session-store',
            turns: rows,
          });
        } catch (err) {
          session.unwrittenCardRedactions.push(rows);
          // eslint-disable-next-line no-console
          console.error('voice-session-store: card-number rewrite of stored turns failed', {
            tenantId: session.tenantId,
            sessionId: session.id,
            callSid,
            turnIndexes: turns.map((t) => t.turnIndex),
            error: err instanceof Error ? err.message : String(err),
          });
        }
      });
  }

  /** Returns the row's insert (resolving to its id, undefined on failure), or undefined when nothing is persisted. */
  private persistTurn(
    session: VoiceSession,
    turnIndex: number,
    entry: TranscriptEntry,
  ): Promise<string | undefined> | undefined {
    const timing = entry.speaker === 'caller' ? entry.timing : undefined;
    const repo = this.callTranscriptTurnRepo;
    if (!repo || !session.callSid) return undefined; // in-app sessions have no CallSid: nothing to key on
    const text = entry.text.trim();
    if (text.length === 0) return undefined; // an empty utterance still took its transcript index
    const { callSid } = session;
    const endpointDelayMs =
      timing?.lastWordAt !== undefined
        ? Math.max(0, timing.sttFinalAt.getTime() - timing.lastWordAt.getTime())
        : undefined;
    // Promise.resolve().then(...) also contains a synchronous throw from the repo.
    const persisted = Promise.resolve()
      .then(() =>
        repo.recordTurn({
          tenantId: session.tenantId,
          callSid,
          sessionId: session.id,
          turnIndex,
          speaker: entry.speaker,
          text,
          ...(timing
            ? {
                transport: timing.transport,
                sttFinalAt: timing.sttFinalAt,
                ...(timing.lastWordAt ? { lastWordAt: timing.lastWordAt } : {}),
                ...(endpointDelayMs !== undefined ? { endpointDelayMs } : {}),
              }
            : {}),
        }),
      )
      .then(
        (row): string | undefined => row?.id,
        (err: unknown): string | undefined => {
          // eslint-disable-next-line no-console
          console.error('voice-session-store: mid-call transcript persist failed', {
            sessionId: session.id,
            callSid,
            turnIndex,
            error: err instanceof Error ? err.message : String(err),
          });
          return undefined;
        },
      );
    if (entry.speaker === 'caller') {
      // A caller turn's reply can still be in flight when the next caller line
      // lands (back-to-back finals), so the last few are retained and older
      // ones dropped: both stay O(1).
      session.pendingTurnPersist.set(turnIndex, persisted);
      if (session.pendingTurnPersist.size > RETAINED_CALLER_TURNS) {
        session.pendingTurnPersist.delete(session.pendingTurnPersist.keys().next().value as number);
      }
      if (timing) {
        session.replyTimings.push({
          turnIndex,
          turnKey: timing.turnKey,
          sttFinalAt: timing.sttFinalAt,
          lastWordAt: timing.lastWordAt,
        });
        if (session.replyTimings.length > RETAINED_CALLER_TURNS) session.replyTimings.shift();
        const early = timing.turnKey !== undefined ? session.pendingReplyStamps.get(timing.turnKey) : undefined;
        if (timing.turnKey !== undefined && early) {
          session.pendingReplyStamps.delete(timing.turnKey);
          void this.writeReplyStamp(session, turnIndex, mergeReplyStamps(early));
        }
      }
    }
    return persisted;
  }

  /**
   * U1 — stamp what the adapter learned about a reply's audio onto the caller
   * turn it answers, addressed by the turn's unique key. When that turn's row
   * has been appended the repository UPDATE is chained behind its
   * `recordTurn` (pending or long settled) so it never races the INSERT. When
   * it has not (the final is still queued behind an earlier turn), the stamp
   * is retained and written the moment `persistTurn` records the row; a key
   * that never gets one is dropped once four newer keys are waiting. An
   * unknown or in-app session, a store with no repository, or a rejected write
   * is a silent no-op for the call; an UPDATE that touches zero rows (the row
   * was deleted underneath it) is counted and logged. The returned promise
   * never rejects — callers may ignore it, tests await it.
   */
  markReplyAudio(sessionId: string, stamp: ReplyAudioStamp): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || !session.callSid || !this.callTranscriptTurnRepo) return Promise.resolve();
    const { turnKey, ...fields } = stamp;
    const row = session.replyTimings.find((t) => t.turnKey === turnKey);
    if (!row) {
      this.retainReplyStamp(session, turnKey, fields);
      return Promise.resolve();
    }
    return this.writeReplyStamp(session, row.turnIndex, fields);
  }

  /** Hold a stamp for a caller row that is not appended yet; evict beyond the last few keys. */
  private retainReplyStamp(session: VoiceSession, turnKey: string, fields: ReplyAudioStampFields): void {
    const held = session.pendingReplyStamps.get(turnKey);
    if (held) {
      held.push(fields);
      return;
    }
    session.pendingReplyStamps.set(turnKey, [fields]);
    if (session.pendingReplyStamps.size > RETAINED_CALLER_TURNS) {
      const oldest = session.pendingReplyStamps.keys().next().value as string;
      session.pendingReplyStamps.delete(oldest);
      // eslint-disable-next-line no-console
      console.warn('voice-session-store: dropped reply-audio stamps for a turn that never got a row', {
        tenantId: session.tenantId,
        callSid: session.callSid,
        sessionId: session.id,
        turnKey: oldest,
      });
    }
  }

  /** Chain the repository UPDATE for one caller row behind its INSERT. Never rejects. */
  private writeReplyStamp(
    session: VoiceSession,
    turnIndex: number,
    fields: ReplyAudioStampFields,
  ): Promise<void> {
    const repo = this.callTranscriptTurnRepo;
    const { callSid } = session;
    if (!repo || !callSid) return Promise.resolve();
    const insert = session.pendingTurnPersist.get(turnIndex) ?? Promise.resolve(undefined);
    return insert
      .then((id) =>
        // By primary key when the insert resolved one (stable across
        // attachRecording's renumbering); the mid-call key only when it never did.
        repo.markReplyAudio({
          tenantId: session.tenantId,
          callSid,
          sessionId: session.id,
          turnIndex,
          ...(id ? { id } : {}),
          ...fields,
        }),
      )
      .then((rows) => {
        if (rows === 0) {
          voiceReplyStampLostTotal.inc();
          // eslint-disable-next-line no-console
          console.warn('voice-session-store: reply-audio stamp matched no row', {
            tenantId: session.tenantId,
            callSid,
            sessionId: session.id,
            turnIndex,
          });
        }
      })
      .catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.error('voice-session-store: reply-audio stamp failed', {
          sessionId: session.id,
          callSid,
          turnIndex,
          error: err instanceof Error ? err.message : String(err),
        });
      });
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
    session.pendingTurnPersist.clear();
    session.pendingReplyStamps.clear();
    session.recentCallerTurns = [];
    session.recentAgentTurns = [];
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
   * WS15 — callSids of LIVE (non-ended) sessions, for the drain-abandonment
   * alarm: when the shutdown drain window expires with live calls remaining,
   * the Sentry event names the abandoned callSids so the operator can match
   * them to Twilio call logs. Sessions without a callSid (web/test channels)
   * are skipped — liveCount() remains the authoritative count.
   */
  liveCallSids(): string[] {
    const sids: string[] = [];
    for (const session of this.sessions.values()) {
      if (!session.ended && session.callSid) sids.push(session.callSid);
    }
    return sids;
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
