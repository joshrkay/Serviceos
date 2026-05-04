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
} from './events';
import {
  VoiceSessionStore,
  type VoiceSession,
} from '../agents/customer-calling/voice-session-store';
import { AgentEventBus } from './event-bus';

// Skills (lookup family — read-only; mirror runLookupSkill from twilio-adapter).
import { lookupAppointments } from '../skills/lookup-appointments';
import { lookupInvoices } from '../skills/lookup-invoices';
import { lookupBalance } from '../skills/lookup-balance';
import { lookupJobs } from '../skills/lookup-jobs';
import { lookupAgreements } from '../skills/lookup-agreements';
import { lookupAccountSummary } from '../skills/lookup-account-summary';
import { lookupCustomer } from '../skills/lookup-customer';
import { lookupEstimates } from '../skills/lookup-estimates';
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
import type { ProposalRepository } from '../../proposals/proposal';

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
  /** Optional audit-trail of every lookup. */
  lookupEvents?: LookupEventService;
  /** Used as `userId` on synthesized voice-action-router messages. */
  systemActorId?: string;
}

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

  constructor(deps: TextModeDriverDeps) {
    this.deps = deps;
    this.voiceActionRouter = createVoiceActionRouterWorker({
      gateway: deps.gateway,
      proposalRepo: deps.proposalRepo,
    });
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
    return { sessionId: session.id };
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

    const startedAt = Date.now();

    // 2. Classify intent. Errors → low-confidence-style "couldn't catch
    //    that" line; mirrors the Twilio adapter's failure-mode for
    //    classifier exceptions (we don't want a 5xx to hang the call).
    let agentResponse: string;
    try {
      const classification = await classifyIntent(
        callerTranscript,
        { tenantId: session.tenantId },
        this.deps.gateway,
      );

      // Emit `intent_classified` on the session bus so the harness sees
      // it (mirrors the emit site twilio-adapter.ts:440 already added).
      session.events.emit(
        'voice-event',
        intentClassifiedEvent({
          intentType: classification.intentType,
          confidence: classification.confidence,
          tokenUsage: classification.tokenUsage,
        }),
      );

      if (classification.intentType === 'unknown') {
        // Mirror the action-router's clarification path. We still want
        // a proposal to land for graders that assert "every utterance
        // produced a visible outcome".
        await this.dispatchToActionRouter(session, callerTranscript);
        agentResponse =
          "I didn't quite catch that — could you say it again? I can help with appointments, invoices, estimates, customer info, and more.";
      } else if (isLookupIntent(classification.intentType)) {
        agentResponse = await this.runLookupSkill(
          session,
          classification.intentType as IntentType,
        );
      } else {
        // Mutation: route through voice-action-router so the same
        // handler set + clarification semantics + entity translation
        // production uses are exercised. The router persists the
        // proposal; we read it back from the repo to build the
        // confirmation string and emit `proposal_created` on the bus
        // (the queue-based router doesn't have a session reference,
        // so the driver does the emit — same shape inapp-adapter
        // already uses at line 523).
        const beforeIds = new Set(
          (await this.deps.proposalRepo.findByTenant(session.tenantId)).map((p) => p.id),
        );
        await this.dispatchToActionRouter(session, callerTranscript);
        const after = await this.deps.proposalRepo.findByTenant(session.tenantId);
        const fresh = after.filter((p) => !beforeIds.has(p.id));
        if (fresh.length > 0) {
          for (const proposal of fresh) {
            session.proposalIds.push(proposal.id);
            session.events.emit('voice-event', {
              type: 'proposal_created',
              proposalId: proposal.id,
            });
          }
          // Use the most recent proposal's type for the confirmation
          // string. With a single-turn router run this is always the
          // one we just emitted; multiple proposals from a single turn
          // would only come from a hypothetical multi-handler router
          // (not on the current code path).
          const latest = fresh[fresh.length - 1];
          agentResponse =
            latest.proposalType === 'voice_clarification'
              ? "I heard you, but I'm not sure what to do — could you say that another way?"
              : buildProposalConfirmation(latest.proposalType);
        } else {
          // Router declined to create anything (e.g. unknown intent
          // with the `voice_clarification` path bypassed by an empty
          // transcript). Fall back to a soft re-prompt.
          agentResponse = "Could you say that again?";
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      agentResponse = `I had trouble processing that — ${message}`;
    }

    const latencyMs = Date.now() - startedAt;

    // Capture the agent's reply on the transcript so summarizeSession
    // sees both sides (mirrors twilio-adapter.processCallerUtterance).
    this.deps.voiceSessionStore.appendTranscript(sessionId, {
      speaker: 'agent',
      text: agentResponse,
      ts: Date.now(),
    });

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
    if (!session) return;
    if (this.deps.bus) {
      this.deps.bus.unsubscribe(session);
    }
    this.deps.voiceSessionStore.delete(sessionId);
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  /**
   * Drive the voice-action-router worker with a synthetic queue
   * message. This is the production code path for proposal creation
   * — same handlers, same clarification fallback, same entity
   * translation — without spinning up a real queue.
   */
  private async dispatchToActionRouter(
    session: VoiceSession,
    transcript: string,
  ): Promise<void> {
    const message: QueueMessage<VoiceActionRouterPayload> = {
      id: `text-mode-${uuidv4()}`,
      type: 'voice_action_router',
      payload: {
        tenantId: session.tenantId,
        userId: this.deps.systemActorId ?? 'system:text-mode',
        transcript,
        ...(session.conversationId ? { conversationId: session.conversationId } : {}),
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
    const startMs = Date.now();
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
            lookupExecutedEvent(intentType, Date.now() - startMs, true),
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
            lookupExecutedEvent(intentType, Date.now() - startMs, true),
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
            lookupExecutedEvent(intentType, Date.now() - startMs, true),
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
            lookupExecutedEvent(intentType, Date.now() - startMs, true),
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
            lookupExecutedEvent(intentType, Date.now() - startMs, true),
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
            lookupExecutedEvent(intentType, Date.now() - startMs, true),
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
            lookupExecutedEvent(intentType, Date.now() - startMs, true),
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
            lookupExecutedEvent(intentType, Date.now() - startMs, true),
          );
          return result.summary;
        }
        default:
          return LOOKUP_NOT_WIRED_FALLBACK;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      session.events.emit(
        'voice-event',
        lookupExecutedEvent(intentType, Date.now() - startMs, false, message),
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
