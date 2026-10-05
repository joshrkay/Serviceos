/**
 * VQ-007 / #1587 — TextModeDriver: drives the voice agent's PRODUCTION turn
 * processor without Twilio I/O. Used by the Voice Quality Layer 1 corpus
 * runner: each scripted call constructs a TextModeDriver, calls `speak()` per
 * turn, and inspects the resulting proposals + bus events.
 *
 * # What this driver is
 * The text twin of a phone transport. A transport owns the leg (TwiML / media
 * frames), establishes the session, appends the caller's words, runs the
 * deterministic life-safety scan, and hands every utterance to ONE place:
 * `createVoiceTurnProcessor().speechTurn` — the shared turn engine both phone
 * transports dispatch into (media-streams finals today; Gather at the #962
 * cutover, which is the surface this driver declares). The driver does the
 * transport's part and nothing more:
 *
 *   - session establishment, as `TwilioGatherAdapter.bootstrapCallEstablishment`
 *     does it — owner-line recognition from caller-ID, the FSM's
 *     incoming_call → greeted_ok → caller_known / unknown_caller bootstrap,
 *     caller-ID identity (exactly one customer on the number, `identifyCaller`'s
 *     rule), and D-033's lead capture for an unknown number;
 *   - the adapter-side emergency scan (`runEmergencyScan`): the production
 *     tier classifier decides, the FSM's `emergency_detected` guard produces
 *     the effects, the processor executes them;
 *   - rendering: every `tts_play` the processor returns is spoken through the
 *     same `renderTtsText` catalog the Gather `<Say>` path uses;
 *   - telemetry for the graders: `speech_outbound` per turn, `proposal_created`
 *     for every proposal the turn persisted, `session_terminated` when the
 *     call closed.
 *
 * # What this driver is NOT (#1587)
 * It carries no turn decision of its own — no identity, spam, after-hours or
 * stale-appointment gate, no mutation path around `speechTurn`, and no spoken
 * copy. Before #1587 it did, and five corpus scripts passed against code no
 * caller could reach (that is how #1552 broke Deploy). A structural test
 * (`test/voice-quality/text-mode-driver.structural.test.ts`) fails the build
 * if any of that grows back. A behaviour the corpus needs therefore has to
 * exist in production, where every phone reaches it.
 *
 * # Hand-off
 * Once the FSM has handed the caller to a person (`escalating`) or closed the
 * call (`terminated`, the cost cap, the life-safety close), a phone transport
 * dispatches no further turns — the leg is bridged or hung up. A scripted
 * turn arriving after that point makes no model call and speaks nothing; the
 * turn marker is still recorded so the graders' per-turn windows line up.
 *
 * # Identity (unchanged, #869)
 * The phone resolves its ACTOR once, at establishment, from caller-ID
 * (`telephony/phone-actor.ts`). This harness has no users substrate, so a
 * recognized owner line (the `callerIsOwner` fixture or a caller-ID match
 * against `tenant_settings.owner_phone`) stamps a SYNTHETIC actor the
 * harness-owned `lookups.answers.resolveMemberRole` maps to `owner`; everyone
 * else gets no actor, exactly like a customer on the phone.
 *
 * # Synthetic CallSid
 * `TEXT_MODE_<uuid>` — unambiguous against real Twilio CallSids (`CA…`).
 *
 * # Latency
 * `speak()` returns `latencyMs` from the start of the turn to the rendered
 * reply, for the floor-3 (`noHang`) check.
 */
import { performance } from 'node:perf_hooks';
import { v4 as uuidv4 } from 'uuid';
import { LLMGateway } from '../gateway/gateway';
import { isApproverPhone } from '../../proposals/approver-identity';
import {
  createVoiceTurnProcessor,
  type VoiceTurnProcessor,
} from '../voice-turn/create-voice-turn-processor';
import { callerTranscriptText } from '../voice-turn/transcript-append';
import {
  lookupExecutedEvent,
  sessionTerminatedEvent,
  speechOutboundEvent,
} from './events';
import {
  VoiceSessionStore,
  type VoiceSession,
} from '../agents/customer-calling/voice-session-store';
import { AgentEventBus } from './event-bus';
import { classifyCallerSafety } from '../agents/customer-calling/emergency-tier';
import { renderTtsText } from '../agents/customer-calling/tts-copy';
import type { SideEffect } from '../agents/customer-calling/types';
import { liveE1Script, type SettingsRepository } from '../../settings/settings';
import { isNanpKey, normalizePhone } from '../../shared/phone';
import { findOrCreateLeadByPhone } from '../skills/find-or-create-lead';
import { resolvePhoneActor } from '../../telephony/phone-actor';
import type { UserRepository } from '../../users/user';
import { CALLER_ID_IDENTITY_LOOKUP_SKILL } from './layer2-world';
import type { OnCallRepository } from '../../oncall/rotation';
import type { CustomerRepository } from '../../customers/customer';
import type { AppointmentRepository } from '../../appointments/appointment';
import type { InvoiceRepository } from '../../invoices/invoice';
import type { EstimateRepository } from '../../estimates/estimate';
import type { JobRepository } from '../../jobs/job';
import type { LeadRepository } from '../../leads/lead';
import type { AuditRepository } from '../../audit/audit';
import type { CatalogItemRepository } from '../../catalog/catalog-item';
import type { EntityResolver } from '../resolution/entity-resolver';
import type { ProposalRepository } from '../../proposals/proposal';
import type { PhoneLookupDeps } from '../voice-turn/phone-lookup-surface';

// ─── Public interface ────────────────────────────────────────────────────────

export interface AgentDriverStartOpts {
  tenantId: string;
  callerId: string | null;
  callerIdBlocked: boolean;
  /**
   * WS21b — force the session to be a recognized owner line (RV-070
   * `ownerSession`), unlocking the owner-only approve/reject/edit dialogue.
   * When omitted, the driver still resolves ownerSession via caller-ID match
   * against `tenant_settings.owner_phone` (production `isApproverPhone`
   * semantics), so a fixture can reach owner state either way.
   */
  callerIsOwner?: boolean;
}

export interface AgentDriverSpeakResult {
  agentResponse: string;
  latencyMs: number;
}

/**
 * Layer-1 + Layer-2 share this contract. The text-mode implementation
 * here drives the orchestration synchronously; the Layer-2
 * implementation wraps real audio + TTS but exposes the same shape
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
  catalogRepo?: CatalogItemRepository;
  /**
   * #1604 — team members (`fixtures.users`). A caller-ID matching a member's
   * registered mobile resolves to the D-026 phone actor through the
   * production resolver (`telephony/phone-actor.ts`), exactly as
   * `establishInboundSession` does; without it only the owner line has an
   * actor.
   */
  userRepo?: Pick<UserRepository, 'findByMobileNumber' | 'findByTenant'>;
  /**
   * #869 — the shared lookup bundle, IDENTICAL in shape to the one the live
   * phone takes (`app.ts` builds one and hands it to every surface). Omit it
   * and every lookup speaks the unavailable line and emits
   * `lookup_executed{success:false, error:'unsupported'}`, exactly as an
   * unwired deployment does on the phone.
   *
   * `answers.resolveMemberRole` is harness-owned: it maps the synthetic owner
   * subject (`vqOwnerActorId`) to `owner` and everything else to null, so the
   * shipped RBAC gate is exercised rather than bypassed.
   */
  lookups?: PhoneLookupDeps;
  /**
   * P0 voice-safety — tenant-scoped entity resolver threaded into the
   * production voice-turn processor, so a corpus script that says "move my
   * Tuesday appointment" exercises real resolution. Optional: without one,
   * resolution degrades to the deterministic parts (datetime phrases,
   * already-UUID ids), as on an unwired deployment.
   */
  entityResolver?: EntityResolver;
  /**
   * #897 — the SAME resolvers production hands the voice-turn processor
   * (app.ts builds them), so the corpus classify prompt carries the tenant's
   * vertical section and the caller's plan section exactly as a live call
   * does. Optional: omitted, the section is absent — as on an unwired
   * deployment.
   */
  verticalPromptResolver?: (tenantId: string) => Promise<string | undefined>;
  callerPlanResolver?: (tenantId: string, customerId: string) => Promise<string | undefined>;
  /** The processor's system actor (audit rows, D-033 capture writes). */
  systemActorId?: string;
  /**
   * On-call rotation — required for escalation. The processor's
   * `notify_oncall` handler only reaches `escalateToHuman` (which emits
   * `escalation_triggered`) with BOTH an on-call repo and an audit repo
   * wired, so the factory seeds at least one rotation entry per tenant.
   */
  onCallRepo?: OnCallRepository;
  /** Tenant settings — language, owner phone, service area, business hours, PIN. */
  settingsRepo?: SettingsRepository;
  /**
   * Clock for spoken-time resolution. Defaults to the wall clock; the corpus
   * pins it to its authored world so booking dates are deterministic.
   */
  now?: () => Date;
}

// ─── Implementation ──────────────────────────────────────────────────────────

const TEXT_MODE_CALLSID_PREFIX = 'TEXT_MODE_';

/**
 * #869 — prefix of the SYNTHETIC actor subject a recognized owner line gets.
 * The harness's `resolveMemberRole` (corpus factory / unit harness) maps any
 * subject carrying this prefix to the `owner` role and everything else to
 * null, so the shipped RBAC gate does the authorising. Distinct from a Clerk
 * subject (`user_…`) on purpose: nothing in this harness is a real user.
 */
export const VQ_OWNER_ACTOR_PREFIX = 'vq-owner:';

/**
 * The owner line's actor subject for a tenant. Deterministic (stable across
 * runs, so cassettes and reports don't churn) and tenant-scoped (so a
 * cross-tenant actor can never resolve).
 */
export function vqOwnerActorId(tenantId: string): string {
  return `${VQ_OWNER_ACTOR_PREFIX}${tenantId}`;
}

/**
 * The harness's `resolveMemberRole` — the SAME seam production resolves a
 * Clerk subject's DB-authoritative role through, so the shared RBAC gate is
 * exercised rather than bypassed. The owner line's synthetic subject is the
 * owner; anything else is unknown, and a permission-gated lookup fails closed
 * to the production refusal copy. Exported so the corpus factory and the unit
 * harness share one definition (they must agree, or the two lanes gate
 * differently).
 */
export const vqResolveMemberRole = (
  _tenantId: string,
  userId: string,
): Promise<string | null> =>
  Promise.resolve(userId.startsWith(VQ_OWNER_ACTOR_PREFIX) ? 'owner' : null);

/**
 * #1604 — `vqResolveMemberRole` over a seeded team (`fixtures.users`): the
 * owner line's synthetic subject is still the owner; a subject the phone
 * actor resolver minted for a seeded member (their Clerk subject, else their
 * row id — `telephony/phone-actor.ts#subjectOf`) resolves to that member's
 * fixture role; anything else stays unknown and fails closed.
 */
export function vqResolveMemberRoleFor(
  userRepo: Pick<UserRepository, 'findByTenant'>,
): (tenantId: string, userId: string) => Promise<string | null> {
  return async (tenantId, userId) => {
    const synthetic = await vqResolveMemberRole(tenantId, userId);
    if (synthetic) return synthetic;
    const users = await userRepo.findByTenant(tenantId);
    return users.find((u) => u.clerkUserId === userId || u.id === userId)?.role ?? null;
  };
}

/**
 * #1604 — skill name stamped on the `lookup_executed` event a caller-ID that
 * matched a team member's registered mobile emits at session establishment:
 * the phone actor IS identity verification (D-026), so the member's own
 * readbacks — which name customers and addresses — are post-identity for the
 * floor PII grader (graders/floor.ts IDENTITY_RESOLVING_LOOKUPS).
 */
export const TEAM_MEMBER_IDENTITY_LOOKUP_SKILL = 'verify_team_member_identity';

/**
 * WS21b — skill name stamped on the `lookup_executed` event a recognized owner
 * line emits at session establishment. The floor PII grader keys identity
 * resolution off this name (see graders/floor.ts IDENTITY_RESOLVING_LOOKUPS):
 * an owner caller-ID match IS identity verification, so owner-only readbacks
 * that name a customer/amount are post-identity, not a pre-identity PII leak.
 */
export const OWNER_IDENTITY_LOOKUP_SKILL = 'verify_owner_identity';

/** FSM states in which a phone transport dispatches no further caller turns. */
const HANDED_OFF_STATES: ReadonlySet<string> = new Set(['escalating', 'terminated']);

export class TextModeDriver implements AgentDriver {
  private readonly deps: TextModeDriverDeps;
  /**
   * The SAME production turn engine the phone transports dispatch into, built
   * once per driver (its deps are stable for the driver's lifetime). Declared
   * for the Gather surface: the coverage table's `gather` cells are the
   * fullest set of processor-served families (lookups, en_route, language
   * switch, owner approval/edit, the one-turn create_customer flow, the
   * silence ladder), anchored to the live Gather loop's behaviour by
   * `test/ai/voice-turn/speechturn-absorbs-gather-delta.test.ts`, and the
   * surface the #962 cutover hands to this engine.
   */
  private readonly voiceProcessor: VoiceTurnProcessor;
  /**
   * Per-session zero-indexed turn counter for the `speech_outbound` marker
   * the graders window turns by. Keyed by `sessionId` because one driver may
   * carry many sessions. Cleared in `endSession`.
   */
  private readonly turnIndexBySession = new Map<string, number>();

  constructor(deps: TextModeDriverDeps) {
    this.deps = deps;
    this.voiceProcessor = createVoiceTurnProcessor({
      store: deps.voiceSessionStore,
      gateway: deps.gateway,
      businessName: 'VQ Harness',
      coverageSurface: 'gather',
      proposalRepo: deps.proposalRepo,
      ...(deps.settingsRepo ? { settingsRepo: deps.settingsRepo } : {}),
      ...(deps.auditRepo ? { auditRepo: deps.auditRepo } : {}),
      ...(deps.onCallRepo ? { onCallRepo: deps.onCallRepo } : {}),
      ...(deps.appointmentRepo ? { appointmentRepo: deps.appointmentRepo } : {}),
      ...(deps.catalogRepo ? { catalogRepo: deps.catalogRepo } : {}),
      ...(deps.jobRepo ? { jobRepo: deps.jobRepo } : {}),
      ...(deps.customerRepo ? { customerRepo: deps.customerRepo } : {}),
      ...(deps.leadRepo ? { leadRepo: deps.leadRepo } : {}),
      ...(deps.invoiceRepo ? { invoiceRepo: deps.invoiceRepo } : {}),
      ...(deps.lookups ? { lookups: deps.lookups } : {}),
      ...(deps.entityResolver ? { entityResolver: deps.entityResolver } : {}),
      ...(deps.verticalPromptResolver ? { verticalPromptResolver: deps.verticalPromptResolver } : {}),
      ...(deps.callerPlanResolver ? { callerPlanResolver: deps.callerPlanResolver } : {}),
      ...(deps.systemActorId ? { systemActorId: deps.systemActorId } : {}),
      ...(deps.now ? { now: deps.now } : {}),
      // The caller-id as the Gather adapter records it per session (Twilio
      // `From`, or '' when blocked/withheld) — read by the one-turn
      // create_customer flow and the ask_caller find-or-create.
      callerPhoneResolver: (session) => session.callerPhone ?? '',
    });
  }

  async startSession(opts: AgentDriverStartOpts): Promise<{ sessionId: string }> {
    const synthetic = `${TEXT_MODE_CALLSID_PREFIX}${uuidv4()}`;
    const tenantId = opts.tenantId;
    // RV-070 owner-line recognition at session establishment (mirrors
    // TwilioGatherAdapter.resolveOwnerSession): an explicit fixture flag OR a
    // caller-ID match against tenant_settings.owner_phone. Fail-closed.
    const ownerSession = await this.resolveOwnerSession(opts);
    const session = this.deps.voiceSessionStore.create(tenantId, 'telephony', {
      callSid: synthetic,
      ...(ownerSession ? { ownerSession: true } : {}),
      // Telephony always opts every caller into the customer-protection
      // intents (establishInboundSession).
      customerProtectionIntents: true,
    });
    await this.pinTenantLanguage(session);
    if (this.deps.bus) {
      this.deps.bus.subscribe(session);
    }

    // #869 — ACTOR, stamped ONCE at establishment and never from utterance
    // content (telephony/phone-actor.ts). See the module doc on identity.
    if (ownerSession) {
      session.actorUserId = vqOwnerActorId(tenantId);
      // The owner line is identity-resolved the instant the session is
      // established (the caller-ID matched the owner phone). Production has
      // no lookup skill for this, so the identity stamp is recorded here for
      // the floor PII grader. The PIN challenge remains the money gate.
      session.events.emit(
        'voice-event',
        lookupExecutedEvent(OWNER_IDENTITY_LOOKUP_SKILL, 0, true),
      );
    }

    // The caller's number as Twilio sends it; '' when blocked/withheld
    // (establishInboundSession pins it for both transports).
    const from = opts.callerId && !opts.callerIdBlocked ? opts.callerId : '';
    if (from) session.callerPhone = from;

    // #1604 — a caller-ID that matches a team member's registered mobile is
    // the D-026 phone actor, resolved ONCE here through the production
    // resolver (`telephony/phone-actor.ts`) and never from utterance content,
    // exactly as establishInboundSession resolves it. The owner line keeps
    // its synthetic subject above; the owner-phone bridge is not exercised.
    if (!ownerSession && from && this.deps.userRepo) {
      const actor = await resolvePhoneActor({ userRepo: this.deps.userRepo }, tenantId, from, false);
      if (actor) {
        session.actorUserId = actor.userId;
        session.events.emit(
          'voice-event',
          lookupExecutedEvent(TEAM_MEMBER_IDENTITY_LOOKUP_SKILL, 0, true),
        );
      }
    }

    // bootstrapCallEstablishment: greeting, then identity, then the FSM's
    // known / unknown branch; the processor executes the audit effects.
    const effects: SideEffect[] = [];
    effects.push(
      ...session.machine.dispatch({
        type: 'incoming_call',
        callSid: synthetic,
        from,
        to: '',
        tenantId,
      }),
    );
    effects.push(...session.machine.dispatch({ type: 'greeted_ok' }));

    const callerKnownId = from ? await this.identifyCallerByPhone(tenantId, from) : null;
    if (callerKnownId) {
      session.customerId = callerKnownId;
      // Caller-ID identified exactly one customer — the identity the phone
      // lookup surface answers a customer's own-records question for. Stamped
      // for the floor PII grader (same stamp as the Layer 2 harness).
      session.events.emit(
        'voice-event',
        lookupExecutedEvent(CALLER_ID_IDENTITY_LOOKUP_SKILL, 0, true),
      );
      effects.push(
        ...session.machine.dispatch({ type: 'caller_known', customerId: callerKnownId }),
      );
    } else {
      // Unknown caller: D-033's sanctioned lead capture (find-or-create by
      // phone) so the call lands in the kanban, exactly as the adapter does;
      // a failure never fails the call. A blocked/empty From has no phone to
      // key a lead on.
      if (this.deps.leadRepo && from) {
        try {
          const result = await findOrCreateLeadByPhone({
            tenantId,
            fromPhone: from,
            leadRepo: this.deps.leadRepo,
            ...(this.deps.auditRepo ? { auditRepo: this.deps.auditRepo } : {}),
            systemActorId: this.deps.systemActorId ?? 'system:inbound-call',
          });
          session.leadId = result.leadId;
        } catch {
          // Fall through to the FSM's unknown_caller path either way.
        }
      }
      effects.push(...session.machine.dispatch({ type: 'unknown_caller' }));
    }
    await this.voiceProcessor.executeSideEffects(session, effects, tenantId);

    return { sessionId: session.id };
  }

  /**
   * #890 — mirror TwilioGatherAdapter.resolveTenantLanguage: the tenant's
   * explicit default_language is the call language; the supported stack is
   * threaded for the language-switch gate. Fail-soft to English.
   */
  private async pinTenantLanguage(session: VoiceSession): Promise<void> {
    if (!this.deps.settingsRepo) return;
    try {
      const settings = await this.deps.settingsRepo.findByTenant(session.tenantId);
      const language = settings?.defaultLanguage === 'es' ? 'es' : 'en';
      session.language = language;
      const stack = settings?.supportedLanguages ?? ['en'];
      session.supportedLanguages = stack.includes(language) ? stack : [...stack, language];
    } catch {
      // English, as production falls back.
    }
  }

  /**
   * Caller-ID identity with `identifyCaller`'s rule (ai/skills/identify-caller.ts),
   * over the customer repository instead of its SQL: a NANP number that
   * matches exactly ONE customer identifies the caller; none or several
   * (`multiple`) is an unknown caller, whom the ask_caller turn resolves.
   */
  private async identifyCallerByPhone(tenantId: string, from: string): Promise<string | null> {
    const repo = this.deps.customerRepo;
    if (!repo?.findByPhoneNormalized) return null;
    const normalized = normalizePhone(from);
    if (!isNanpKey(normalized)) return null;
    try {
      const matches = await repo.findByPhoneNormalized(tenantId, normalized);
      return matches.length === 1 ? matches[0]!.id : null;
    } catch {
      return null;
    }
  }

  /**
   * WS21b — resolve whether this caller is a recognized owner line. An
   * explicit fixture `callerIsOwner` wins; otherwise mirror production's
   * caller-ID identity check (`isApproverPhone` against
   * tenant_settings.owner_phone). Best-effort + fail-closed: any lookup
   * failure resolves to non-owner so a degraded dependency can never mint an
   * owner session.
   */
  private async resolveOwnerSession(opts: AgentDriverStartOpts): Promise<boolean> {
    if (opts.callerIsOwner === true) return true;
    if (!this.deps.settingsRepo || !opts.callerId) return false;
    try {
      return await isApproverPhone(
        { settingsRepo: this.deps.settingsRepo },
        opts.tenantId,
        opts.callerId,
      );
    } catch {
      return false;
    }
  }

  async speak(
    sessionId: string,
    callerTranscript: string,
  ): Promise<AgentDriverSpeakResult> {
    const session = this.deps.voiceSessionStore.get(sessionId);
    if (!session) {
      throw new Error(`text-mode driver: unknown session ${sessionId}`);
    }
    const tenantId = session.tenantId;
    // `performance.now()` for sub-millisecond resolution: on fast hardware a
    // whole turn completes inside one ms and `Date.now()` deltas round to 0.
    const startedAt = performance.now();

    // Hand-off: see the module doc. No model call, nothing spoken.
    if (session.ended || HANDED_OFF_STATES.has(session.machine.currentState)) {
      this.emitTurn(session, sessionId, '');
      return { agentResponse: '', latencyMs: performance.now() - startedAt };
    }

    // The caller's words go on the transcript before anything reads them
    // (the Gather loop appends, then scans, then dispatches).
    this.deps.voiceSessionStore.appendTranscript(sessionId, {
      speaker: 'caller',
      text: callerTranscriptText(session, callerTranscript),
      ts: Date.now(),
    });

    const proposalsBefore = session.proposalIds.length;
    let effects = await this.runEmergencyScan(session, callerTranscript, tenantId);
    if (effects === null) {
      effects = await this.voiceProcessor.speechTurn({
        session,
        speechResult: callerTranscript,
        callSid: session.callSid ?? '',
        tenantId,
        transcriptAppended: true,
      });
    }

    const agentResponse = this.renderSpoken(session, effects);
    if (effects.some((fx) => fx.type === 'end_session')) {
      session.ended = true;
    }
    for (const proposalId of session.proposalIds.slice(proposalsBefore)) {
      session.events.emit('voice-event', { type: 'proposal_created', proposalId });
    }
    this.emitTurn(session, sessionId, agentResponse);
    return { agentResponse, latencyMs: performance.now() - startedAt };
  }

  /**
   * The adapter-side life-safety scan, as `TwilioGatherAdapter.runEmergencyScan`
   * runs it before any model call on both phone transports: the production
   * tier classifier decides (E1 life safety closes the call on the evacuation
   * script; E2 hands off to the on-call dispatcher; E3 is not an emergency),
   * the FSM's `emergency_detected` guard produces the effects, and the
   * processor executes them. Returns null when the turn proceeds normally.
   */
  private async runEmergencyScan(
    session: VoiceSession,
    callerTranscript: string,
    tenantId: string,
  ): Promise<SideEffect[] | null> {
    const safety = classifyCallerSafety(callerTranscript, {});
    if (safety.tier === 'E3') return null;

    let responseScript = safety.responseScript;
    let scriptSource: 'reviewed' | 'placeholder' = 'placeholder';
    if (safety.tier === 'E1' && this.deps.settingsRepo) {
      try {
        // #1389 / O-2 — the tenant's reviewed script, live only with both sign-offs.
        const reviewed = liveE1Script(await this.deps.settingsRepo.findByTenant(tenantId));
        if (reviewed) {
          responseScript = reviewed;
          scriptSource = 'reviewed';
        }
      } catch {
        // Placeholder script, as production falls back.
      }
    }
    const effects = session.machine.dispatch({
      type: 'emergency_detected',
      keyword: safety.keyword,
      utterance: callerTranscript,
      tier: safety.tier,
      ...(responseScript ? { responseScript } : {}),
      ...(safety.tier === 'E1' ? { scriptSource } : {}),
      ...(safety.language ? { language: safety.language } : {}),
      ...(session.language === 'es' || session.language === 'en'
        ? { sessionLanguage: session.language }
        : {}),
    });
    if (effects.length === 0) return null;
    await this.voiceProcessor.executeSideEffects(session, effects, tenantId);
    if (safety.tier === 'E1' && session.machine.currentState === 'terminated') {
      session.events.emit('voice-event', sessionTerminatedEvent('life_safety_e1'));
      session.ended = true;
    }
    return effects;
  }

  /**
   * What the caller hears: every `tts_play` the turn produced, rendered
   * through the same catalog the Gather `<Say>` path renders with (templates
   * expanded, Spanish sessions localized), in order.
   */
  private renderSpoken(session: VoiceSession, effects: SideEffect[]): string {
    const lang = session.language === 'es' ? 'es' : 'en';
    return effects
      .filter(
        (fx) => fx.type === 'tts_play' && typeof fx.payload.text === 'string' && fx.payload.text.length > 0,
      )
      .map((fx) => renderTtsText(fx.payload.text as string, fx.payload, lang))
      .join(' ');
  }

  /**
   * Turn marker for the graders: one `speech_outbound` per scripted turn
   * carrying the zero-indexed turn position (the agent's spoken text may be
   * empty after hand-off).
   */
  private emitTurn(session: VoiceSession, sessionId: string, agentResponse: string): void {
    const turnIndex = this.turnIndexBySession.get(sessionId) ?? 0;
    this.turnIndexBySession.set(sessionId, turnIndex + 1);
    session.events.emit(
      'voice-event',
      speechOutboundEvent({
        transcript: agentResponse,
        turnIndex,
      }),
    );
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
    if (!session) return;
    if (this.deps.bus) {
      this.deps.bus.unsubscribe(session);
    }
    this.deps.voiceSessionStore.delete(sessionId);
  }
}

/**
 * Convenience factory: lets call-sites wire a TextModeDriver from a
 * deps bundle without manually `new`-ing through the class.
 */
export function createTextModeDriver(deps: TextModeDriverDeps): TextModeDriver {
  return new TextModeDriver(deps);
}
