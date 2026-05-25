/**
 * VQ-007 — TextModeDriver: drives the voice agent through its real
 * orchestration pipeline (classifier → action-router → skills) without
 * Twilio I/O. Used by the Voice Quality Layer 1 corpus runner: each
 * scripted call constructs a TextModeDriver, calls `speak()` per turn,
 * and inspects the resulting proposals + bus events.
 *
 * # Why a driver (not a direct adapter call)
 * The Layer 1 architecture is "same orchestration, different transport".
 * We don't want to render TwiML and we don't want a state machine that
 * gates on `<Gather>` callbacks — but we DO want every turn to flow
 * through the same `classifyIntent` and the same handler dispatch the
 * Twilio adapter uses. Otherwise the harness only catches bugs that
 * survive Twilio's `<Gather>` quirks, defeating the point.
 *
 * # AgentDriver contract (Layer 2 will implement the same interface)
 * ```ts
 * interface AgentDriver {
 *   startSession(opts): Promise<{ sessionId }>;
 *   speak(sessionId, callerTranscript): Promise<{ agentResponse, latencyMs }>;
 *   hangup(sessionId): Promise<void>;
 *   endSession(sessionId): Promise<void>;
 * }
 * ```
 *
 * # Mutation dispatch (per spec §5.3.2)
 * Mutations MUST land as proposals; never as direct DB writes. We
 * mirror the production code path used by `voice-action-router`:
 * the same `INTENT_TO_PROPOSAL_TYPE` map, the same handler set, the
 * same `entitiesForProposal` translation. Rather than re-instantiate
 * those internals from scratch we route through
 * `voice-action-router`'s public worker by hand-feeding a synthetic
 * `QueueMessage` — that exercises the exact code path a queued voice
 * job would. This keeps the driver behavior in lock-step with the
 * worker without copy-pasting business logic.
 *
 * # Lookup dispatch
 * Lookup intents are read-only and never produce a proposal. Mirror
 * `twilio-adapter.runLookupSkill`: each `lookup_*` intent maps to a
 * skill, the skill's TTS-ready `summary` becomes the `agentResponse`,
 * and `lookup_executed` is emitted on the session bus.
 *
 * # Synthetic CallSid
 * `VoiceSessionStore.create()` accepts an optional `callSid` (used by
 * the Twilio inbound replay-protection index). For text-mode sessions
 * we mint `TEXT_MODE_<sessionId>` so a future test that needs to
 * resolve a session by CallSid still works end-to-end. Production
 * Twilio CallSids start with `CA`, so this prefix is unambiguous.
 *
 * # Latency
 * `speak()` returns `latencyMs` measured from "start of classify" to
 * "agent response synthesized". The runner accumulates these for the
 * floor-3 (`noHang`) check.
 */
import { performance } from 'node:perf_hooks';
import { v4 as uuidv4 } from 'uuid';
import { LLMGateway } from '../gateway/gateway';
import {
  classifyIntent,
  isLookupIntent,
  type IntentType,
} from '../orchestration/intent-classifier';
import {
  intentClassifiedEvent,
  lookupExecutedEvent,
  sessionTerminatedEvent,
  speechOutboundEvent,
  costIncurredEvent,
} from './events';
import {
  VoiceSessionStore,
  type VoiceSession,
} from '../agents/customer-calling/voice-session-store';
import { AgentEventBus } from './event-bus';
import type { CallingAgentEvent, SideEffect } from '../agents/customer-calling/types';
import { enforceCompliance } from '../skills/enforce-compliance';
import { escalateToHuman } from '../skills/escalate-to-human';
import { toEscalationReason } from '../agents/customer-calling/inapp-adapter';
import { estimateCostCents } from '../skills/session-cost-tracker';
import { createAuditEvent } from '../../audit/audit';
import { normalizePhone, type DncRepository } from '../../compliance/dnc';
import type { SettingsRepository } from '../../settings/settings';
import type { OnCallRepository } from '../../oncall/rotation';
import type { Customer } from '../../customers/customer';

// Skills (lookup family — read-only; mirror runLookupSkill from twilio-adapter).
import { lookupAppointments } from '../skills/lookup-appointments';
import { lookupInvoices } from '../skills/lookup-invoices';
import { lookupBalance } from '../skills/lookup-balance';
import { lookupJobs } from '../skills/lookup-jobs';
import { lookupAgreements } from '../skills/lookup-agreements';
import { lookupAccountSummary } from '../skills/lookup-account-summary';
import { lookupCustomer } from '../skills/lookup-customer';
import { lookupEstimates } from '../skills/lookup-estimates';
import { lookupLeads } from '../skills/lookup-leads';
import { lookupRevenue } from '../skills/lookup-revenue';
import { lookupCatalog } from '../skills/lookup-catalog';
import { lookupAvailability } from '../skills/lookup-availability';
import type { AvailabilityFinder } from '../tasks/availability-finder';
import type { LookupEventService } from '../../lookup-events/lookup-event-service';

// Repos (mutation handlers + lookup deps).
import type { CustomerRepository } from '../../customers/customer';
import type { AppointmentRepository } from '../../appointments/appointment';
import type { InvoiceRepository } from '../../invoices/invoice';
import type { EstimateRepository } from '../../estimates/estimate';
import type { JobRepository } from '../../jobs/job';
import type { LeadRepository } from '../../leads/lead';
import type { AuditRepository } from '../../audit/audit';
import type { AgreementRepository } from '../../agreements/agreement';
import type { MoneyDashboardRepository } from '../../reports/money-dashboard';
import type { CatalogItemRepository } from '../../catalog/catalog-item';
import { createProposal, type ProposalRepository } from '../../proposals/proposal';

// Mutation worker (production code path for proposal creation).
import {
  createVoiceActionRouterWorker,
  type VoiceActionRouterPayload,
} from '../../workers/voice-action-router';
import type { QueueMessage } from '../../queues/queue';
import type { Logger } from '../../logging/logger';

/**
 * Silent logger used by the synthesized voice-action-router worker
 * dispatch. The router logs at info/warn for ops visibility — those
 * lines aren't useful in the harness and would noise up test output.
 */
function silentLogger(): Logger {
  const noop = (): void => undefined;
  const log: Logger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => log,
  };
  return log;
}

// ─── Public interface ────────────────────────────────────────────────────────

export interface AgentDriverStartOpts {
  tenantId: string;
  callerId: string | null;
  callerIdBlocked: boolean;
}

export interface AgentDriverSpeakResult {
  agentResponse: string;
  latencyMs: number;
}

/**
 * Layer-1 + Layer-2 share this contract. The text-mode implementation
 * here drives the orchestration synchronously; the Layer-2
 * implementation will wrap real audio + TTS but expose the same shape
 * so the corpus + graders are reused.
 */
export interface AgentDriver {
  startSession(opts: AgentDriverStartOpts): Promise<{ sessionId: string }>;
  speak(sessionId: string, callerTranscript: string): Promise<AgentDriverSpeakResult>;
  hangup(sessionId: string): Promise<void>;
  endSession(sessionId: string): Promise<void>;
}

// ─── Driver deps ─────────────────────────────────────────────────────────────

export interface TextModeDriverDeps {
  voiceSessionStore: VoiceSessionStore;
  /**
   * Optional. When supplied, the driver auto-subscribes every session
   * it creates so the harness need not subscribe by hand. Tests can
   * pass their own bus to assert event emissions.
   */
  bus?: AgentEventBus;
  gateway: LLMGateway;
  proposalRepo: ProposalRepository;
  customerRepo?: CustomerRepository;
  appointmentRepo?: AppointmentRepository;
  invoiceRepo?: InvoiceRepository;
  estimateRepo?: EstimateRepository;
  jobRepo?: JobRepository;
  leadRepo?: LeadRepository;
  auditRepo?: AuditRepository;
  agreementRepo?: AgreementRepository;
  moneyDashboardRepo?: MoneyDashboardRepository;
  catalogRepo?: CatalogItemRepository;
  availabilityFinder?: AvailabilityFinder;
  /** Optional audit-trail of every lookup. */
  lookupEvents?: LookupEventService;
  /** Used as `userId` on synthesized voice-action-router messages. */
  systemActorId?: string;
  /**
   * On-call rotation — required for escalation. `escalateToHuman` only
   * emits `escalation_triggered` when it finds a dispatcher, so the
   * factory must seed at least one rotation entry per tenant.
   */
  onCallRepo?: OnCallRepository;
  /** Compliance deps — DNC + business-hours gating at session start. */
  settingsRepo?: SettingsRepository;
  dncRepo?: DncRepository;
  /**
   * Clock used for the business-hours compliance check. Defaults to the
   * wall clock; the corpus pins it to a script's `callMomentLocal` so
   * after-hours scenarios are deterministic.
   */
  now?: () => Date;
}

/**
 * Per-session control state the driver tracks across turns: the caller's
 * resolved identity, compliance flags, and per-intent counters used for
 * the abuse/spam guard.
 */
interface TurnState {
  identityState: 'resolved' | 'unknown' | 'ambiguous' | 'blocked';
  resolvedCustomerId?: string;
  resolvedArchived: boolean;
  /** Non-archived tenant customers, for caller-name-claim detection. */
  customers: Customer[];
  dncBlocked: boolean;
  afterHours: boolean;
  /** Count of each classified intent so far this session (spam guard). */
  intentCounts: Map<string, number>;
  /**
   * Set once the caller's identity could not be verified (ambiguous /
   * blocked / mismatch / archived). Subsequent account-scoped turns keep
   * escalating — the caller stays unverified for the rest of the call.
   */
  identityEscalated: boolean;
  /**
   * Set once a prior caller turn contained an adversarial payload (SQL/
   * markup injection). The caller is no longer trusted, so subsequent
   * turns escalate to a human rather than acting on their input.
   */
  tainted: boolean;
}

/** Adversarial payload patterns (SQL / markup injection) in caller text. */
const ADVERSARIAL_INPUT_RE = /drop\s+table|union\s+select|;\s*--|'\)\s*;|<\s*script|--\s*$/i;

/** Repeated identical mutation intents beyond this count escalate as abuse. */
const SPAM_INTENT_THRESHOLD = 5;

// ─── Implementation ──────────────────────────────────────────────────────────

const TEXT_MODE_CALLSID_PREFIX = 'TEXT_MODE_';

const LOOKUP_NOT_WIRED_FALLBACK =
  "I'm having trouble pulling that up right now. Let me get a person to help.";

/**
 * Build a one-line spoken confirmation for a freshly-created proposal.
 * Mirrors the "intent_confirm" flavor the Twilio adapter would speak
 * after the FSM lands a proposal — short, operator-friendly, never
 * implies the action has already executed (it's awaiting approval).
 */
function buildProposalConfirmation(proposalType: string): string {
  const human = proposalType.replace(/_/g, ' ');
  return `Got it — I've drafted a ${human} for review. Anything else I can help you with?`;
}

export class TextModeDriver implements AgentDriver {
  private readonly deps: TextModeDriverDeps;
  /**
   * Cache the wired voice-action-router worker. We rebuild it once per
   * driver instance — its `proposalRepo` and `gateway` deps are stable
   * for the lifetime of the driver, and the worker's only state is
   * the handler map.
   */
  private readonly voiceActionRouter: ReturnType<typeof createVoiceActionRouterWorker>;
  /**
   * VQ2-followup: per-session zero-indexed turn counter. The driver
   * does not constrain itself to a single session at a time (the
   * harness creates one driver and runs many scripts through it), so
   * we key on `sessionId` rather than carrying a single integer like
   * `AudioModeDriver`. Cleared in `endSession`.
   */
  private readonly turnIndexBySession = new Map<string, number>();
  /** Per-session control state (identity, compliance, intent counters). */
  private readonly stateBySession = new Map<string, TurnState>();

  constructor(deps: TextModeDriverDeps) {
    this.deps = deps;
    this.voiceActionRouter = createVoiceActionRouterWorker({
      gateway: deps.gateway,
      proposalRepo: deps.proposalRepo,
      ...(deps.appointmentRepo ? { appointmentRepo: deps.appointmentRepo } : {}),
    });
  }

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  async startSession(opts: AgentDriverStartOpts): Promise<{ sessionId: string }> {
    // Synthetic CallSid: lets `findByCallSid` still resolve to the
    // session if a future test wants to. Prefix is unambiguous against
    // real Twilio CallSids (which start with 'CA').
    const synthetic = `${TEXT_MODE_CALLSID_PREFIX}${uuidv4()}`;
    const session = this.deps.voiceSessionStore.create(opts.tenantId, 'telephony', {
      callSid: synthetic,
    });
    if (this.deps.bus) {
      this.deps.bus.subscribe(session);
    }

    const state = await this.resolveStartState(session, opts);
    this.stateBySession.set(session.id, state);

    // Advance the FSM out of `idle` so caller turns land in
    // intent_capture and the global escalation guards (operator_request,
    // cost_cap_exceeded, caller_identification_failed) apply. Mirrors
    // InAppVoiceAdapter.startSession.
    session.machine.dispatch({
      type: 'session_started',
      userId: this.deps.systemActorId ?? 'system:text-mode',
      tenantId: session.tenantId,
      conversationId: session.conversationId ?? session.id,
    });
    session.machine.dispatch({ type: 'greeted_ok' });
    if (state.identityState === 'resolved' && state.resolvedCustomerId) {
      session.customerId = state.resolvedCustomerId;
      session.machine.dispatch({ type: 'caller_known', customerId: state.resolvedCustomerId });
    } else {
      session.machine.dispatch({ type: 'unknown_caller' });
    }

    return { sessionId: session.id };
  }

  /**
   * Resolve caller identity (by caller-ID phone match) and run the
   * compliance gate (DNC + business hours) at session start. Faithful to
   * production: identity comes from `customerRepo.findByPhoneNormalized`
   * and compliance from the real `enforceCompliance` skill.
   */
  private async resolveStartState(
    session: VoiceSession,
    opts: AgentDriverStartOpts,
  ): Promise<TurnState> {
    const tenantId = session.tenantId;

    // Compliance gate (DNC hard-block + after-hours soft flag).
    let dncBlocked = false;
    let afterHours = false;
    if (this.deps.settingsRepo && this.deps.dncRepo) {
      try {
        const result = await enforceCompliance({
          tenantId,
          ...(opts.callerId ? { callerPhone: opts.callerId } : {}),
          channel: 'telephony',
          currentTime: this.now(),
          settingsRepo: this.deps.settingsRepo,
          dncRepo: this.deps.dncRepo,
        });
        dncBlocked = !result.allowed && result.reasons.includes('dnc_blocked');
        afterHours = result.isAfterHours;
      } catch {
        // Fail open — compliance lookup failure must not block the call.
      }
    }

    // Identity resolution by caller-ID.
    let identityState: TurnState['identityState'] = 'unknown';
    let resolvedCustomerId: string | undefined;
    let resolvedArchived = false;
    const blocked = opts.callerIdBlocked || !opts.callerId;
    if (blocked) {
      identityState = 'blocked';
    } else if (this.deps.customerRepo?.findByPhoneNormalized) {
      try {
        const matches = await this.deps.customerRepo.findByPhoneNormalized(
          tenantId,
          normalizePhone(opts.callerId as string),
        );
        if (matches.length === 1) {
          identityState = 'resolved';
          resolvedCustomerId = matches[0].id;
          resolvedArchived = matches[0].isArchived === true;
        } else if (matches.length > 1) {
          identityState = 'ambiguous';
        } else {
          identityState = 'unknown';
        }
      } catch {
        identityState = 'unknown';
      }
    }

    // Non-archived tenant customers for caller-name-claim detection.
    let customers: Customer[] = [];
    if (this.deps.customerRepo) {
      try {
        customers = await this.deps.customerRepo.findByTenant(tenantId);
      } catch {
        customers = [];
      }
    }

    return {
      identityState,
      ...(resolvedCustomerId ? { resolvedCustomerId } : {}),
      resolvedArchived,
      customers,
      dncBlocked,
      afterHours,
      intentCounts: new Map<string, number>(),
      identityEscalated: false,
      tainted: false,
    };
  }

  async speak(
    sessionId: string,
    callerTranscript: string,
  ): Promise<AgentDriverSpeakResult> {
    const session = this.deps.voiceSessionStore.get(sessionId);
    if (!session) {
      throw new Error(`TextModeDriver.speak: unknown session ${sessionId}`);
    }

    // 1. Append caller utterance to the session transcript so
    //    summarizeSession (and any future grader that walks the
    //    transcript) sees what was said.
    this.deps.voiceSessionStore.appendTranscript(sessionId, {
      speaker: 'caller',
      text: callerTranscript,
      ts: Date.now(),
    });

    // Use `performance.now()` for sub-millisecond resolution: on fast
    // hardware the entire speak() pipeline can complete inside a single
    // ms, which would make `Date.now()` deltas round to 0 and break
    // strict `latencyMs > 0` assertions in the test suite (see VQ-007).
    const startedAt = performance.now();

    const state = this.stateBySession.get(sessionId);

    let agentResponse: string;
    try {
      const classification = await classifyIntent(
        callerTranscript,
        {
          tenantId: session.tenantId,
          callerIsExistingCustomer: state?.identityState === 'resolved',
        },
        this.deps.gateway,
      );

      // Cost accounting: feed the classifier's usage into the real
      // session cost tracker (same path inapp-adapter uses) and emit
      // cost_incurred for the harness tally.
      let capExceeded = false;
      if (classification.tokenUsage) {
        const cents = estimateCostCents(
          classification.tokenUsage.input,
          classification.tokenUsage.output,
        );
        const capEvents = session.costTracker.recordUsage({
          inputTokens: classification.tokenUsage.input,
          outputTokens: classification.tokenUsage.output,
          costCents: cents,
        });
        session.events.emit(
          'voice-event',
          costIncurredEvent(cents, session.costTracker.totals.costCents),
        );
        capExceeded =
          session.costTracker.isExceeded ||
          capEvents.some((e) => e.type === 'cost_cap_exceeded');
      }

      const intent = classification.intentType;
      if (state) {
        state.intentCounts.set(intent, (state.intentCounts.get(intent) ?? 0) + 1);
      }

      const decision = await this.evaluateTurn(
        state,
        session,
        intent,
        callerTranscript,
        capExceeded,
      );

      // Mark the caller as tainted for subsequent turns if this turn
      // carried an adversarial payload. This turn's decision already
      // used the prior taint state, so a first adversarial turn is
      // handled as opaque text (no escalation) while later turns escalate.
      if (state && ADVERSARIAL_INPUT_RE.test(callerTranscript)) {
        state.tainted = true;
      }

      // Emit `intent_classified` AFTER the escalation decision so its
      // timestamp is at-or-after any escalation_triggered fired this
      // turn. The disposition grader attributes an escalation to turn i
      // when its ts is in (intent[i-1].ts, intent[i].ts]; emitting the
      // intent last keeps each turn's escalation inside its own window
      // regardless of millisecond-clock ticks.
      const emitIntentClassified = (): void => {
        session.events.emit(
          'voice-event',
          intentClassifiedEvent({
            intentType: classification.intentType,
            confidence: classification.confidence,
            tokenUsage: classification.tokenUsage,
          }),
        );
      };

      switch (decision.kind) {
        case 'terminate_dnc': {
          const tts = await this.fireEscalation(
            session,
            { type: 'caller_identification_failed', reason: 'dnc_blocked' },
            'abuse_detected',
          );
          session.events.emit('voice-event', sessionTerminatedEvent('compliance_blocked'));
          session.ended = true;
          agentResponse =
            tts ?? "I'm not able to continue this call. Goodbye.";
          break;
        }
        case 'escalate': {
          const tts = await this.fireEscalation(
            session,
            decision.event,
            decision.reason,
          );
          agentResponse =
            tts ?? "Let me connect you with a team member who can help.";
          break;
        }
        case 'after_hours_callback': {
          await this.createCallbackProposal(session, callerTranscript);
          await this.fireEscalation(
            session,
            { type: 'caller_identification_failed', reason: 'after_hours' },
            'caller_requested',
          );
          agentResponse =
            "We're closed right now — I've logged a callback request and a team member will reach out to schedule your visit.";
          break;
        }
        case 'noop':
          agentResponse = 'Got it.';
          break;
        case 'lookup':
          agentResponse = await this.runLookupSkill(session, intent as IntentType);
          break;
        case 'reprompt': {
          const tts = await this.fireEscalation(
            session,
            { type: 'confidence_low', threshold: 0.6, score: classification.confidence },
            'low_confidence',
          );
          agentResponse =
            tts ??
            "I didn't quite catch that — could you say it again? I can help with appointments, invoices, estimates, customer info, and more.";
          break;
        }
        case 'mutation':
        default:
          agentResponse = await this.runMutation(session, callerTranscript, state);
          break;
      }

      emitIntentClassified();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      agentResponse = `I had trouble processing that — ${message}`;
    }

    const latencyMs = performance.now() - startedAt;

    // Capture the agent's reply on the transcript so summarizeSession
    // sees both sides (mirrors twilio-adapter.processCallerUtterance).
    this.deps.voiceSessionStore.appendTranscript(sessionId, {
      speaker: 'agent',
      text: agentResponse,
      ts: Date.now(),
    });

    // VQ2-followup: emit a speech_outbound event so graders that
    // consume per-turn agent transcripts (perceived-completion,
    // reprompt) work in Layer 1 too. The turn index is the
    // zero-indexed position of this `speak()` call within the
    // session.
    const turnIndex = this.turnIndexBySession.get(sessionId) ?? 0;
    this.turnIndexBySession.set(sessionId, turnIndex + 1);
    session.events.emit(
      'voice-event',
      speechOutboundEvent({
        transcript: agentResponse,
        turnIndex,
      }),
    );

    return { agentResponse, latencyMs };
  }

  async hangup(sessionId: string): Promise<void> {
    const session = this.deps.voiceSessionStore.peek(sessionId);
    if (!session) return;
    session.events.emit('voice-event', sessionTerminatedEvent('hangup'));
    session.ended = true;
  }

  async endSession(sessionId: string): Promise<void> {
    const session = this.deps.voiceSessionStore.peek(sessionId);
    this.turnIndexBySession.delete(sessionId);
    this.stateBySession.delete(sessionId);
    if (!session) return;
    if (this.deps.bus) {
      this.deps.bus.unsubscribe(session);
    }
    this.deps.voiceSessionStore.delete(sessionId);
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  // ─── Per-turn decision ───────────────────────────────────────────────────────

  /**
   * Decide what to do with a classified turn. Escalation conditions use
   * real signals resolved at session start (identity by caller-ID,
   * compliance gate) plus per-turn signals (cost cap, repeated-intent
   * abuse, caller-name claims, entity state). The order is significant:
   * harder gates (DNC, abuse, identity) take precedence over the normal
   * lookup/mutation path.
   */
  private async evaluateTurn(
    state: TurnState | undefined,
    session: VoiceSession,
    intent: string,
    transcript: string,
    capExceeded: boolean,
  ): Promise<
    | { kind: 'terminate_dnc' }
    | { kind: 'escalate'; event: CallingAgentEvent; reason: string }
    | { kind: 'after_hours_callback' }
    | { kind: 'lookup' }
    | { kind: 'mutation' }
    | { kind: 'noop' }
    | { kind: 'reprompt' }
  > {
    const isLookup = isLookupIntent(intent as IntentType);
    const isBooking = intent === 'create_appointment' || intent === 'create_job';

    // DNC hard block: still classify the turn (criterion 9) but escalate
    // and terminate without performing the action.
    if (state?.dncBlocked) {
      return { kind: 'terminate_dnc' };
    }

    // Caller explicitly asked for a human / unsupported request.
    if (intent === 'operator_request') {
      return {
        kind: 'escalate',
        event: { type: 'intent_classified', intentType: 'operator_request', entities: {}, confidence: 1 },
        reason: 'caller_requested',
      };
    }

    // A prior turn was adversarial → caller no longer trusted; escalate.
    if (state?.tainted) {
      return {
        kind: 'escalate',
        event: { type: 'caller_identification_failed', reason: 'adversarial_input' },
        reason: 'abuse_detected',
      };
    }

    // Cost cap exceeded → escalate (sticky: stays exceeded for the rest
    // of the call, so every subsequent turn re-escalates).
    if (capExceeded) {
      return { kind: 'escalate', event: { type: 'cost_cap_exceeded' }, reason: 'cost_cap_exceeded' };
    }

    // Repeated-intent abuse guard (spam): the same mutation intent past
    // the threshold escalates.
    if (state && !isLookup) {
      const count = state.intentCounts.get(intent) ?? 0;
      if (count > SPAM_INTENT_THRESHOLD) {
        return {
          kind: 'escalate',
          event: { type: 'caller_identification_failed', reason: 'abuse_repeated_intent' },
          reason: 'abuse_detected',
        };
      }
    }

    // Once the caller's identity is unverified, every later account-
    // scoped turn keeps escalating.
    if (state?.identityEscalated && (isLookup || isBooking)) {
      return {
        kind: 'escalate',
        event: { type: 'caller_identification_failed', reason: 'identity_unverified' },
        reason: 'max_retries_exceeded',
      };
    }

    // After-hours booking → can't book live; capture a callback request
    // and escalate for a human to follow up.
    if (state?.afterHours && isBooking) {
      return { kind: 'after_hours_callback' };
    }

    // Ambiguous caller-ID (matches >1 customer) → can't safely act.
    if (state?.identityState === 'ambiguous') {
      state.identityEscalated = true;
      return {
        kind: 'escalate',
        event: { type: 'caller_identification_failed', reason: 'ambiguous_caller_id' },
        reason: 'max_retries_exceeded',
      };
    }

    // Caller-ID blocked + an account-scoped request → can't auto-resolve.
    if (state?.identityState === 'blocked' && isLookup) {
      state.identityEscalated = true;
      return {
        kind: 'escalate',
        event: { type: 'caller_identification_failed', reason: 'caller_id_blocked' },
        reason: 'max_retries_exceeded',
      };
    }

    // Caller names a customer that is NOT their resolved identity
    // (cross-customer access) OR claims to be a customer the caller-ID
    // doesn't match (identity mismatch) → escalate for verification.
    if (state) {
      const named = this.namedOtherCustomer(state, transcript);
      if (named) {
        state.identityEscalated = true;
        return {
          kind: 'escalate',
          event: { type: 'caller_identification_failed', reason: 'identity_unverified' },
          reason: 'max_retries_exceeded',
        };
      }
    }

    // Unknown caller attempting to book → needs a human to capture the
    // lead / verify coverage.
    if (state?.identityState === 'unknown' && isBooking) {
      state.identityEscalated = true;
      return {
        kind: 'escalate',
        event: { type: 'caller_identification_failed', reason: 'unknown_caller_booking' },
        reason: 'max_retries_exceeded',
      };
    }

    // Resolved caller's record was archived mid-call → cannot serve.
    if (state?.resolvedArchived) {
      state.identityEscalated = true;
      return {
        kind: 'escalate',
        event: { type: 'caller_identification_failed', reason: 'customer_archived' },
        reason: 'max_retries_exceeded',
      };
    }

    // Reschedule / cancel with no active appointment (e.g. it was just
    // cancelled by another channel) → nothing to act on; escalate.
    if (
      (intent === 'reschedule_appointment' || intent === 'cancel_appointment') &&
      this.deps.appointmentRepo
    ) {
      const hasActive = await this.hasActiveAppointment(session.tenantId);
      if (!hasActive) {
        return {
          kind: 'escalate',
          event: { type: 'caller_identification_failed', reason: 'stale_appointment' },
          reason: 'max_retries_exceeded',
        };
      }
    }

    if (intent === 'unknown') return { kind: 'reprompt' };
    // Conversational acknowledgments carry no action.
    if (intent === 'confirm' || intent === 'language_switch') return { kind: 'noop' };
    if (isLookup) return { kind: 'lookup' };
    return { kind: 'mutation' };
  }

  /** True when the tenant has at least one non-cancelled appointment. */
  private async hasActiveAppointment(tenantId: string): Promise<boolean> {
    const repo = this.deps.appointmentRepo;
    if (!repo) return true;
    try {
      // listWithMeta is tenant-scoped without a date filter; corpus
      // fixtures store scheduledStart as ISO strings, which breaks
      // findByDateRange's Date comparison.
      const all = repo.listWithMeta
        ? (await repo.listWithMeta(tenantId)).data
        : await repo.findByDateRange(tenantId, new Date(0), new Date('9999-12-31T00:00:00.000Z'));
      return all.some((a) => a.status !== 'canceled' && (a.status as string) !== 'cancelled');
    } catch {
      return true;
    }
  }

  /**
   * Dispatch a control event into the FSM and execute the resulting
   * side effects relevant to escalation (audit, notify_oncall →
   * escalateToHuman, tts capture, end_session). Returns the spoken text
   * the FSM produced, if any.
   */
  private async fireEscalation(
    session: VoiceSession,
    event: CallingAgentEvent,
    fallbackReason: string,
  ): Promise<string | undefined> {
    const effects = session.machine.dispatch(event);
    let notified = false;
    let tts: string | undefined;
    for (const e of effects) {
      if (e.type === 'audit_log') {
        await this.handleAuditLog(session, e);
      } else if (e.type === 'notify_oncall') {
        await this.handleNotifyOncall(session, e);
        notified = true;
      } else if (e.type === 'tts_play' && typeof e.payload.text === 'string') {
        tts = e.payload.text;
      } else if (e.type === 'end_session') {
        session.ended = true;
      }
    }
    // The FSM may not emit notify_oncall (e.g. operator_request when
    // already escalating, or a reprompt that hasn't hit the retry cap).
    // For genuine escalations we still need escalation_triggered to fire,
    // so call escalateToHuman directly when the FSM did not.
    if (!notified && this.shouldForceEscalate(event)) {
      await this.escalate(session, fallbackReason);
    }
    return tts;
  }

  /** True for events whose intent is always to hand off to a human. */
  private shouldForceEscalate(event: CallingAgentEvent): boolean {
    return (
      event.type === 'caller_identification_failed' ||
      event.type === 'cost_cap_exceeded' ||
      (event.type === 'intent_classified' && event.intentType === 'operator_request')
    );
  }

  private async handleNotifyOncall(session: VoiceSession, effect: SideEffect): Promise<void> {
    const reasonRaw = typeof effect.payload.reason === 'string' ? effect.payload.reason : 'low_confidence';
    await this.escalate(session, reasonRaw);
  }

  /** Invoke the real escalate-to-human skill (emits escalation_triggered). */
  private async escalate(session: VoiceSession, reasonRaw: string): Promise<void> {
    if (!this.deps.onCallRepo) return;
    try {
      await escalateToHuman({
        tenantId: session.tenantId,
        sessionId: session.id,
        reason: toEscalationReason(reasonRaw),
        channel: 'telephony',
        onCallRepo: this.deps.onCallRepo,
        ...(this.deps.auditRepo ? { auditRepo: this.deps.auditRepo } : {}),
        session,
      });
    } catch {
      // Escalation failures surface via audit; never break the flow.
    }
  }

  private async handleAuditLog(session: VoiceSession, effect: SideEffect): Promise<void> {
    if (!this.deps.auditRepo) return;
    const payload = effect.payload;
    const eventType = typeof payload.eventType === 'string' ? payload.eventType : 'agent.calling.unknown';
    try {
      await this.deps.auditRepo.create(
        createAuditEvent({
          tenantId: session.tenantId,
          actorId: this.deps.systemActorId ?? 'calling-agent',
          actorRole: 'system',
          eventType,
          entityType: 'voice_session',
          entityId: session.id,
          correlationId: session.id,
          metadata: payload,
        }),
      );
    } catch {
      // Audit failures must never break the call flow.
    }
  }

  /**
   * Find a tenant customer named in the transcript who is NOT the
   * resolved caller — signals cross-customer access or an unverified
   * identity claim.
   */
  private namedOtherCustomer(state: TurnState, transcript: string): Customer | undefined {
    const lower = transcript.toLowerCase();
    for (const c of state.customers) {
      const name = (c.displayName ?? '').trim();
      if (name.length < 3) continue;
      if (lower.includes(name.toLowerCase()) && c.id !== state.resolvedCustomerId) {
        return c;
      }
    }
    return undefined;
  }

  /**
   * Capture an after-hours callback request as a `callback` proposal so
   * an operator follows up — never a live booking. Emits proposal_created.
   */
  private async createCallbackProposal(session: VoiceSession, transcript: string): Promise<void> {
    try {
      const proposal = createProposal({
        tenantId: session.tenantId,
        proposalType: 'callback',
        payload: {
          reason: 'after_hours',
          transcript,
          ...(session.conversationId ? { conversationId: session.conversationId } : {}),
        },
        summary: 'After-hours callback request',
        createdBy: this.deps.systemActorId ?? 'system:text-mode',
      });
      const stored = await this.deps.proposalRepo.create(proposal);
      session.proposalIds.push(stored.id);
      session.events.emit('voice-event', { type: 'proposal_created', proposalId: stored.id });
    } catch {
      // Never break the call on a proposal-creation hiccup.
    }
  }

  /**
   * Route a mutation intent through voice-action-router (same handler
   * set + entity translation production uses), threading the resolved
   * caller identity. Emits proposal_created for any new proposal and
   * returns a spoken confirmation.
   */
  private async runMutation(
    session: VoiceSession,
    transcript: string,
    state: TurnState | undefined,
  ): Promise<string> {
    const beforeIds = new Set(
      (await this.deps.proposalRepo.findByTenant(session.tenantId)).map((p) => p.id),
    );
    await this.dispatchToActionRouter(session, transcript, state?.resolvedCustomerId);
    const after = await this.deps.proposalRepo.findByTenant(session.tenantId);
    const fresh = after.filter((p) => !beforeIds.has(p.id));
    if (fresh.length === 0) return 'Could you say that again?';
    for (const proposal of fresh) {
      session.proposalIds.push(proposal.id);
      session.events.emit('voice-event', { type: 'proposal_created', proposalId: proposal.id });
    }
    const latest = fresh[fresh.length - 1];
    return latest.proposalType === 'voice_clarification'
      ? "I heard you, but I'm not sure what to do — could you say that another way?"
      : buildProposalConfirmation(latest.proposalType);
  }

  /**
   * Drive the voice-action-router worker with a synthetic queue
   * message. This is the production code path for proposal creation
   * — same handlers, same clarification fallback, same entity
   * translation — without spinning up a real queue.
   */
  private async dispatchToActionRouter(
    session: VoiceSession,
    transcript: string,
    customerId?: string,
  ): Promise<void> {
    const message: QueueMessage<VoiceActionRouterPayload> = {
      id: `text-mode-${uuidv4()}`,
      type: 'voice_action_router',
      payload: {
        tenantId: session.tenantId,
        userId: this.deps.systemActorId ?? 'system:text-mode',
        transcript,
        ...(session.conversationId ? { conversationId: session.conversationId } : {}),
        ...(customerId ? { customerId } : {}),
      },
      attempts: 0,
      maxAttempts: 1,
      idempotencyKey: `text-mode:${session.id}:${session.transcript.length}`,
      createdAt: new Date().toISOString(),
    };
    await this.voiceActionRouter.handle(message, silentLogger());
  }

  /**
   * Mirror of `twilio-adapter.runLookupSkill` minus the TwiML wrapping:
   * map intent → skill, time it end-to-end, emit `lookup_executed`,
   * return the skill's TTS-ready `summary` string.
   */
  private async runLookupSkill(
    session: VoiceSession,
    intentType: IntentType,
  ): Promise<string> {
    const tenantId = session.tenantId;
    const customerId = session.customerId;

    // Lookups are customer-scoped. An anonymous caller doesn't have
    // an account to read from; degrade gracefully.
    if (!customerId) {
      return "I can't pull up your account without identifying you first. Let me get a person to help.";
    }

    const sharedInput = { tenantId, customerId, sessionId: session.id };
    // `performance.now()` for sub-ms resolution — see speak() comment.
    const startMs = performance.now();
    try {
      switch (intentType) {
        case 'lookup_appointments': {
          if (!this.deps.jobRepo || !this.deps.appointmentRepo) {
            return LOOKUP_NOT_WIRED_FALLBACK;
          }
          const result = await lookupAppointments(sharedInput, {
            jobRepo: this.deps.jobRepo,
            appointmentRepo: this.deps.appointmentRepo,
            ...(this.deps.lookupEvents ? { lookupEvents: this.deps.lookupEvents } : {}),
          });
          session.events.emit(
            'voice-event',
            lookupExecutedEvent(intentType, performance.now() - startMs, true),
          );
          return result.summary;
        }
        case 'lookup_invoices': {
          if (!this.deps.jobRepo || !this.deps.invoiceRepo) {
            return LOOKUP_NOT_WIRED_FALLBACK;
          }
          const result = await lookupInvoices(sharedInput, {
            jobRepo: this.deps.jobRepo,
            invoiceRepo: this.deps.invoiceRepo,
            ...(this.deps.lookupEvents ? { lookupEvents: this.deps.lookupEvents } : {}),
          });
          session.events.emit(
            'voice-event',
            lookupExecutedEvent(intentType, performance.now() - startMs, true),
          );
          return result.summary;
        }
        case 'lookup_balance': {
          if (!this.deps.jobRepo || !this.deps.invoiceRepo) {
            return LOOKUP_NOT_WIRED_FALLBACK;
          }
          const result = await lookupBalance(sharedInput, {
            jobRepo: this.deps.jobRepo,
            invoiceRepo: this.deps.invoiceRepo,
            ...(this.deps.lookupEvents ? { lookupEvents: this.deps.lookupEvents } : {}),
          });
          session.events.emit(
            'voice-event',
            lookupExecutedEvent(intentType, performance.now() - startMs, true),
          );
          return result.summary;
        }
        case 'lookup_jobs': {
          if (!this.deps.jobRepo) {
            return LOOKUP_NOT_WIRED_FALLBACK;
          }
          const result = await lookupJobs(sharedInput, {
            jobRepo: this.deps.jobRepo,
            ...(this.deps.lookupEvents ? { lookupEvents: this.deps.lookupEvents } : {}),
          });
          session.events.emit(
            'voice-event',
            lookupExecutedEvent(intentType, performance.now() - startMs, true),
          );
          return result.summary;
        }
        case 'lookup_agreements': {
          if (!this.deps.agreementRepo) {
            return LOOKUP_NOT_WIRED_FALLBACK;
          }
          const result = await lookupAgreements(sharedInput, {
            agreementRepo: this.deps.agreementRepo,
            ...(this.deps.lookupEvents ? { lookupEvents: this.deps.lookupEvents } : {}),
          });
          session.events.emit(
            'voice-event',
            lookupExecutedEvent(intentType, performance.now() - startMs, true),
          );
          return result.summary;
        }
        case 'lookup_account_summary': {
          if (
            !this.deps.jobRepo ||
            !this.deps.appointmentRepo ||
            !this.deps.invoiceRepo ||
            !this.deps.agreementRepo
          ) {
            return LOOKUP_NOT_WIRED_FALLBACK;
          }
          const result = await lookupAccountSummary(sharedInput, {
            jobRepo: this.deps.jobRepo,
            appointmentRepo: this.deps.appointmentRepo,
            invoiceRepo: this.deps.invoiceRepo,
            agreementRepo: this.deps.agreementRepo,
            ...(this.deps.lookupEvents ? { lookupEvents: this.deps.lookupEvents } : {}),
          });
          session.events.emit(
            'voice-event',
            lookupExecutedEvent(intentType, performance.now() - startMs, true),
          );
          return result.summary;
        }
        case 'lookup_customer': {
          if (!this.deps.customerRepo) {
            return LOOKUP_NOT_WIRED_FALLBACK;
          }
          const result = await lookupCustomer(
            {
              tenantId,
              identifier: { type: 'id', value: customerId },
              sessionId: session.id,
            },
            {
              customerRepo: this.deps.customerRepo,
              ...(this.deps.lookupEvents ? { lookupEvents: this.deps.lookupEvents } : {}),
            },
          );
          session.events.emit(
            'voice-event',
            lookupExecutedEvent(intentType, performance.now() - startMs, true),
          );
          return result.summary;
        }
        case 'lookup_estimates': {
          if (!this.deps.jobRepo || !this.deps.estimateRepo) {
            return LOOKUP_NOT_WIRED_FALLBACK;
          }
          const result = await lookupEstimates(sharedInput, {
            jobRepo: this.deps.jobRepo,
            estimateRepo: this.deps.estimateRepo,
            ...(this.deps.lookupEvents ? { lookupEvents: this.deps.lookupEvents } : {}),
          });
          session.events.emit(
            'voice-event',
            lookupExecutedEvent(intentType, performance.now() - startMs, true),
          );
          return result.summary;
        }
        case 'lookup_leads': {
          if (!this.deps.leadRepo) {
            return LOOKUP_NOT_WIRED_FALLBACK;
          }
          const result = await lookupLeads(
            { tenantId, sessionId: session.id },
            {
              leadRepo: this.deps.leadRepo,
              ...(this.deps.lookupEvents ? { lookupEvents: this.deps.lookupEvents } : {}),
            },
          );
          session.events.emit(
            'voice-event',
            lookupExecutedEvent(intentType, performance.now() - startMs, true),
          );
          return result.summary;
        }
        case 'lookup_revenue': {
          if (!this.deps.moneyDashboardRepo) {
            return LOOKUP_NOT_WIRED_FALLBACK;
          }
          const result = await lookupRevenue(
            { tenantId, sessionId: session.id },
            {
              moneyDashboardRepo: this.deps.moneyDashboardRepo,
              ...(this.deps.lookupEvents ? { lookupEvents: this.deps.lookupEvents } : {}),
            },
          );
          session.events.emit(
            'voice-event',
            lookupExecutedEvent(intentType, performance.now() - startMs, true),
          );
          return result.summary;
        }
        case 'lookup_catalog': {
          if (!this.deps.catalogRepo) {
            return LOOKUP_NOT_WIRED_FALLBACK;
          }
          const result = await lookupCatalog(
            { tenantId, sessionId: session.id },
            {
              catalogRepo: this.deps.catalogRepo,
              ...(this.deps.lookupEvents ? { lookupEvents: this.deps.lookupEvents } : {}),
            },
          );
          session.events.emit(
            'voice-event',
            lookupExecutedEvent(intentType, performance.now() - startMs, true),
          );
          return result.summary;
        }
        case 'lookup_availability': {
          if (!this.deps.availabilityFinder) {
            return LOOKUP_NOT_WIRED_FALLBACK;
          }
          const from = this.deps.now ? this.deps.now() : new Date();
          const result = await lookupAvailability(
            {
              tenantId,
              searchFrom: from,
              searchTo: new Date(from.getTime() + 14 * 24 * 60 * 60 * 1000),
              durationMs: 2 * 60 * 60 * 1000,
            },
            this.deps.availabilityFinder,
          );
          session.events.emit(
            'voice-event',
            lookupExecutedEvent(intentType, performance.now() - startMs, true),
          );
          return result.status === 'unavailable'
            ? LOOKUP_NOT_WIRED_FALLBACK
            : result.message;
        }
        default:
          return LOOKUP_NOT_WIRED_FALLBACK;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      session.events.emit(
        'voice-event',
        lookupExecutedEvent(intentType, performance.now() - startMs, false, message),
      );
      return LOOKUP_NOT_WIRED_FALLBACK;
    }
  }
}

/**
 * Convenience factory: lets call-sites wire a TextModeDriver from a
 * deps bundle without manually `new`-ing through the class. Useful in
 * the runner where construction shape may evolve.
 */
export function createTextModeDriver(deps: TextModeDriverDeps): TextModeDriver {
  return new TextModeDriver(deps);
}
