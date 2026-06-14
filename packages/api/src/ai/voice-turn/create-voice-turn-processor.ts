/**
 * VoiceTurnProcessor — closure-captured agent loop extracted from
 * `TwilioGatherAdapter` so both production AND the Layer 2 voice-quality
 * harness can drive the real agent through a single factory.
 *
 * Production (`app.ts`) wires `attachMediaStreamServer` with a `speechTurn`
 * that delegates to `TwilioGatherAdapter#processCallerUtterance`. That
 * method (~170 LOC) plus the helpers it transitively reaches
 * (`recordCost`, `executeSideEffects`, `handleAuditLog`,
 * `handleCreateProposal`, `handleNotifyOncall`, the prompt/threshold
 * resolvers, the FSM-confirm-template expansion, the terminated-session
 * finalize, and the end-of-call summary) all lived on the adapter class
 * and so could not be reused without instantiating the whole adapter.
 *
 * This module re-homes that surface as a closure-captured factory:
 *
 *   - `speechTurn`               — the SpeechTurnHandler the media-streams
 *                                  adapter calls; same body as the old
 *                                  `processCallerUtterance` minus the
 *                                  `session` lookup (the WS adapter already
 *                                  resolves it from `start.callSid`).
 *   - `finalizeTerminatedSession`— derive + stash CallOutcome + best-effort
 *                                  persist to voice_sessions. Same
 *                                  signature `(session, sideEffects, reason)`
 *                                  the route layer + media-streams `finalizeOnClose`
 *                                  expect.
 *   - `executeSideEffects`,
 *     `recordCost`,
 *     `expandIntentConfirmTemplate`,
 *     `resolveVerticalPromptSection`,
 *     `resolvePlanPromptSection`,
 *     `resolveThresholdOverride`,
 *     `runSummary`               — exposed so the rest of `TwilioGatherAdapter`
 *                                  (handleInbound, _handleGatherLocked,
 *                                  initializeStreamSession, queueCallbackProposal,
 *                                  finalizeTwiml) can call them directly
 *                                  instead of duplicating logic.
 *
 * The ephemeral `pendingTransferTwiml` session map is accepted as a dep
 * so the adapter and processor share the same Map instance. When the
 * adapter omits it, a fresh empty Map is created — useful for tests.
 *
 * Production behavior is preserved verbatim: same audit emissions, same
 * proposal payload shape, same FSM dispatch order, same cost tracking,
 * same voice-event emissions.
 */

import { v4 as uuidv4 } from 'uuid';
import type { Pool } from 'pg';
import { appendAgentTts } from './transcript-append';
import { classifyIntent, isVoiceApprovalIntent, isVoiceEditIntent } from '../orchestration/intent-classifier';
import {
  startVoiceApproval,
  continueVoiceApproval,
  startVoiceEdit,
  type OneTapFallbackDeps,
  type VoiceApprovalDeps,
  type VoiceApprovalTurnResult,
} from '../tasks/proposal-approval-task';
import { createLlmEditInterpreter } from '../../proposals/edit-interpreter';
import type { ProposalSmsEventRepository } from '../../proposals/sms/sms-event';
import { confirmIntent } from '../skills/confirm-intent';
import { summarizeSession } from '../skills/summarize-session';
import {
  escalateToHuman,
  emergencyImmediateDial,
  EMERGENCY_INTENTS,
} from '../skills/escalate-to-human';
import { estimateCostCents } from '../skills/session-cost-tracker';
import {
  intentClassifiedEvent,
  costIncurredEvent,
  sessionTerminatedEvent,
  escalationStartedEvent,
} from '../voice-quality/events';
import { VOICE_EVENT_CHANNEL } from '../voice-quality/event-bus';
import { buildEscalationSummary } from '../agents/customer-calling/escalation-summary-builder';
import { buildCallerContextFromSession } from '../agents/customer-calling/escalation-context-from-session';
import type { WhisperCache } from '../../telephony/whisper-cache';
import type { PanelData } from '../agents/customer-calling/escalation-summary-builder';
import { TAU_INT } from '../agents/customer-calling/transitions';
import type {
  CallingAgentEvent,
  SideEffect,
} from '../agents/customer-calling/types';
import type {
  VoiceSession,
  VoiceSessionStore,
} from '../agents/customer-calling/voice-session-store';
import { deriveCallOutcome } from '../agents/customer-calling/outcome-mapper';
import type { VoiceSessionRepository } from '../../voice/voice-session';
import type {
  ProposalRepository,
  ProposalType,
} from '../../proposals/proposal';
import { createProposal as buildProposal } from '../../proposals/proposal';
import { buildNegotiationCallbackContent } from '../../proposals/guardrails/negotiation-guardrail';
import type { LeadRepository } from '../../leads/lead';
import type { AuditRepository } from '../../audit/audit';
import { createAuditEvent } from '../../audit/audit';
import type { OnCallRepository } from '../../oncall/rotation';
import type { TwilioCallControl } from '../../telephony/twilio-call-control';
import { maskPhone } from '../../telephony/twilio-call-control';
import type { DispatcherPhoneResolver } from '../skills/escalate-to-human';
import type { TenantCredentialResolver } from '../../integrations/credentials';
import type { JobRepository } from '../../jobs/job';
import type { AppointmentRepository } from '../../appointments/appointment';
import type { InvoiceRepository } from '../../invoices/invoice';
import type { AgreementRepository } from '../../agreements/agreement';
import type { CustomerRepository } from '../../customers/customer';
import type { EstimateRepository } from '../../estimates/estimate';
import type { LookupEventService } from '../../lookup-events/lookup-event-service';
import type { LLMGateway } from '../gateway/gateway';
import type {
  VoiceRepository,
  CallOutcome,
} from '../../voice/voice-service';
import type { VoicePersonaResolver } from '../../settings/voice-persona-resolver';
import type { SettingsRepository } from '../../settings/settings';
import { resolveEscalationSettings } from '../../settings/settings';
import type { SpeechTurnHandler } from '../../telephony/media-streams/mediastream-adapter';
import { createLogger } from '../../logging/logger';
import { scheduleDroppedCallRecovery } from '../../telephony/dropped-call-recovery';

const logger = createLogger({
  service: 'ai.voice-turn.processor',
  environment: process.env.NODE_ENV || 'development',
});

/**
 * XML-escape (mirrors `twilio-adapter.ts#xmlEscape`). Re-implemented
 * locally so this module never imports back from `telephony/twilio-adapter`,
 * which would create a circular import once the adapter delegates here.
 */
function mapNotifyReasonToSkillReason(
  reason: string,
): Parameters<typeof escalateToHuman>[0]['reason'] {
  if (reason === 'operator_request') return 'caller_requested';
  if (reason === 'emergency_dispatch') return 'emergency_dispatch';
  if (reason === 'cost_cap_exceeded') return 'cost_cap_exceeded';
  if (reason.startsWith('abuse')) return 'abuse_detected';
  if (reason === 'keyword_frustration' || reason === 'llm_sentiment') {
    return 'caller_requested';
  }
  if (reason === 'max_retries_exceeded') return 'max_retries_exceeded';
  return 'low_confidence';
}

/**
 * Voice-parity (Feature 7): the receiving CSR must get the context SMS BEFORE
 * the call bridges. We await provider acceptance of the SMS, but bound the wait
 * so a slow/hung provider can never exceed Twilio's webhook budget — past this
 * deadline we bridge anyway (a late text beats a dropped transfer).
 */
const SMS_BEFORE_BRIDGE_TIMEOUT_MS = 4000;

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Map a classifier intent string to the typed ProposalType bucket. */
function intentToProposalType(intent: string | undefined): ProposalType {
  switch (intent) {
    case 'create_invoice':
      return 'draft_invoice';
    case 'update_invoice':
      return 'update_invoice';
    case 'issue_invoice':
      return 'issue_invoice';
    case 'send_invoice':
      return 'send_invoice';
    case 'send_estimate':
      return 'send_estimate';
    case 'record_payment':
      return 'record_payment';
    case 'draft_estimate':
      return 'draft_estimate';
    case 'update_estimate':
      return 'update_estimate';
    case 'create_appointment':
      return 'create_appointment';
    case 'reschedule_appointment':
      return 'reschedule_appointment';
    case 'cancel_appointment':
      return 'cancel_appointment';
    case 'reassign_appointment':
      return 'reassign_appointment';
    case 'create_customer':
      return 'create_customer';
    case 'create_job':
      return 'create_job';
    case 'add_note':
      return 'add_note';
    case 'emergency_dispatch':
      return 'emergency_dispatch';
    default:
      return 'voice_clarification';
  }
}

export interface VoiceTurnProcessorDeps {
  store: VoiceSessionStore;
  gateway: LLMGateway;
  pool?: Pool;
  auditRepo?: AuditRepository;
  proposalRepo?: ProposalRepository;
  onCallRepo?: OnCallRepository;
  leadRepo?: LeadRepository;
  systemActorId?: string;
  businessName: string;
  publicBaseUrl?: string;
  callControl?: TwilioCallControl;
  dispatcherPhoneResolver?: DispatcherPhoneResolver;
  recordingCallbackPath?: string;
  jobRepo?: JobRepository;
  appointmentRepo?: AppointmentRepository;
  invoiceRepo?: InvoiceRepository;
  agreementRepo?: AgreementRepository;
  customerRepo?: CustomerRepository;
  estimateRepo?: EstimateRepository;
  lookupEvents?: LookupEventService;
  credentialResolver?: TenantCredentialResolver;
  verticalPromptResolver?: (tenantId: string) => Promise<string | undefined>;
  callerPlanResolver?: (
    tenantId: string,
    customerId: string,
  ) => Promise<string | undefined>;
  thresholdResolver?: (
    tenantId: string,
  ) => Promise<
    Partial<Record<'supervisor' | 'tech' | 'both', number>> | undefined
  >;
  voiceSessionRepo?: VoiceSessionRepository;
  voiceRepo?: VoiceRepository;
  voicePersonaResolver?: VoicePersonaResolver;
  /**
   * Optional shared map. When the host (TwilioGatherAdapter) provides
   * its own Map instance, the processor reads/writes the same instance
   * so the host's other entry points (handleInbound, handleNotifyOncall,
   * etc.) see the same state. When omitted, a fresh empty Map is
   * created — appropriate for tests and standalone harness use.
   */
  pendingTransferTwiml?: Map<string, string>;
  /**
   * Optional callback fired when a session terminates so the host can
   * trigger any post-terminate work. The adapter wires this so its
   * existing `runSummary` path still kicks off after a terminal turn.
   *
   * `speechTurn` `await`s this callback (wrapped in try/catch). The
   * callback may return immediately by spawning its own background work
   * (production keeps fire-and-forget summary inside the adapter's
   * wiring to preserve Twilio webhook latency), OR it may await its
   * own work (Layer 2 awaits `runSummary` so the runner's per-run
   * suite-cost-tracker snapshot includes the summary's gateway spend).
   *
   * When omitted, the processor falls back to a fire-and-forget
   * `runSummary` for parity with the adapter's legacy behavior.
   */
  onSessionTerminated?: (session: VoiceSession) => void | Promise<void>;
  /**
   * F8 — when wired, `handleNotifyOncall` loads per-tenant escalation
   * settings and threads channel preferences into `escalateToHuman`.
   * Optional: when absent, all three channels default to enabled.
   */
  settingsRepo?: SettingsRepository;
  /** F3 — whisper TwiML cache for dispatcher ear-only context. */
  whisperCache?: WhisperCache;
  /** F4 — outbound SMS to dispatcher on escalation. */
  deliveryProvider?: { sendSms(args: { to: string; body: string }): Promise<unknown> };
  /**
   * Caller E.164 for the active leg. When set, used to build escalation
   * summaries; otherwise a placeholder is used.
   */
  callerPhoneResolver?: (session: VoiceSession) => string | undefined;
  /**
   * RV-071 — pending-edit parity guard for voice approvals (same repo
   * method the SMS reply transport and the one-tap route use). Optional:
   * without it the guard is skipped, mirroring pre-P2-034 wiring.
   * RV-225 — `create` (when wired, i.e. the full repo) additionally lets
   * the voice edit dialogue record edit_request / reapproval_rendered
   * events so unapplied voice edits block approval on every channel.
   */
  smsEventRepo?: Pick<ProposalSmsEventRepository, 'hasUnappliedEditRequest'> &
    Partial<Pick<ProposalSmsEventRepository, 'create'>>;
  /**
   * RV-071 — one-tap SMS fallback wiring for refused money/irreversible
   * voice approvals. Same values app.ts already wires for P12-004
   * unsupervised routing (secret, sender, URL builder, owner phone,
   * P2-034 render recording).
   */
  voiceApprovalOneTap?: OneTapFallbackDeps;
}

export interface VoiceTurnProcessor {
  /**
   * Drives a single speech turn through the FSM and returns the
   * resulting side effects. Matches the `SpeechTurnHandler` contract
   * `attachMediaStreamServer` accepts so it can be wired directly.
   */
  speechTurn: SpeechTurnHandler;
  /**
   * Derive + stash the typed CallOutcome on the session and kick off
   * the best-effort `voice_sessions` persist. Idempotent.
   */
  finalizeTerminatedSession(
    session: VoiceSession,
    sideEffects: ReadonlyArray<SideEffect>,
    fallbackReason: string,
  ): void;
  /** Execute audit/proposal/notify_oncall side effects against wired repos. */
  executeSideEffects(
    session: VoiceSession,
    sideEffects: SideEffect[],
    tenantId: string,
  ): Promise<void>;
  /** Push token usage into the cost tracker. Returns true on cap exceeded. */
  recordCost(
    session: VoiceSession,
    usage: { input: number; output: number } | undefined,
  ): boolean;
  /** Replace a placeholder `intent_confirm` tts_play with a concrete readback. */
  expandIntentConfirmTemplate(
    sideEffects: SideEffect[],
    intentType: string,
  ): void;
  resolveVerticalPromptSection(
    tenantId: string,
  ): Promise<string | undefined>;
  resolvePlanPromptSection(
    tenantId: string,
    customerId: string | undefined,
  ): Promise<string | undefined>;
  resolveThresholdOverride(
    tenantId: string,
  ): Promise<
    Partial<Record<'supervisor' | 'tech' | 'both', number>> | undefined
  >;
  /** Persist the end-of-call summary. Best-effort. */
  runSummary(session: VoiceSession): Promise<void>;
  /**
   * RV-071 — consume the turn when an owner voice-approval dialogue is
   * pending on the session (confirm / disambiguate / challenge stage).
   * Returns the side effects to render, or null when no dialogue is
   * pending (caller proceeds with the normal turn). Shared by
   * `speechTurn` (WS path) and the Gather adapter so both transports run
   * the identical safety flow.
   */
  handlePendingVoiceApproval(
    session: VoiceSession,
    speechResult: string,
    tenantId: string,
  ): Promise<SideEffect[] | null>;
  /**
   * RV-071 — route a classified `approve_proposal` / `reject_proposal`
   * intent. HARD-GATED on the session's RV-070 `ownerSession` flag (not
   * just the classifier prompt): non-owner callers fall into the FSM's
   * normal `confidence_low` reprompt path and no approval flow starts.
   */
  handleVoiceApprovalIntent(
    session: VoiceSession,
    args: {
      intentType: string;
      entities: Record<string, unknown>;
      utterance: string;
      tenantId: string;
    },
  ): Promise<SideEffect[]>;
  /**
   * RV-225 — route a classified `edit_proposal` intent ("change the
   * second line to $200"). Same layered gating as the approval intents:
   * HARD-GATED on the session's RV-070 `ownerSession` flag, never
   * prompt-only. The edit applies through the existing `editProposal`
   * path and the proposal STAYS pending (an edit never approves).
   */
  handleVoiceEditIntent(
    session: VoiceSession,
    args: {
      entities: Record<string, unknown>;
      utterance: string;
      tenantId: string;
    },
  ): Promise<SideEffect[]>;
}

export function createVoiceTurnProcessor(
  deps: VoiceTurnProcessorDeps,
): VoiceTurnProcessor {
  const pendingTransferTwiml =
    deps.pendingTransferTwiml ?? new Map<string, string>();

  // ─── Helpers (formerly private methods on TwilioGatherAdapter) ──────

  async function resolveVerticalPromptSection(
    tenantId: string,
  ): Promise<string | undefined> {
    if (!deps.verticalPromptResolver) return undefined;
    try {
      return await deps.verticalPromptResolver(tenantId);
    } catch {
      return undefined;
    }
  }

  async function resolvePlanPromptSection(
    tenantId: string,
    customerId: string | undefined,
  ): Promise<string | undefined> {
    if (!deps.callerPlanResolver || !customerId) return undefined;
    try {
      return await deps.callerPlanResolver(tenantId, customerId);
    } catch {
      return undefined;
    }
  }

  async function resolveThresholdOverride(
    tenantId: string,
  ): Promise<
    Partial<Record<'supervisor' | 'tech' | 'both', number>> | undefined
  > {
    if (!deps.thresholdResolver) return undefined;
    try {
      return await deps.thresholdResolver(tenantId);
    } catch {
      return undefined;
    }
  }

  function recordCost(
    session: VoiceSession,
    usage: { input: number; output: number } | undefined,
  ): boolean {
    if (!usage) return false;
    const cents = estimateCostCents(usage.input, usage.output);
    const events = session.costTracker.recordUsage({
      inputTokens: usage.input,
      outputTokens: usage.output,
      costCents: cents,
    });
    session.events.emit(
      'voice-event',
      costIncurredEvent(cents, session.costTracker.totals.costCents),
    );
    const exceeded = events.some((e) => e.type === 'cost_cap_exceeded');
    if (exceeded) {
      session.events.emit('voice-event', sessionTerminatedEvent('cap_exceeded'));
    }
    return exceeded;
  }

  function expandIntentConfirmTemplate(
    sideEffects: SideEffect[],
    intentType: string,
  ): void {
    for (const fx of sideEffects) {
      if (
        fx.type === 'tts_play' &&
        (fx.payload.text === 'intent_confirm' ||
          fx.payload.template === 'confirm_intent')
      ) {
        fx.payload.text = `Just to confirm — ${intentType.replace(/_/g, ' ')}. Is that right?`;
      }
    }
  }

  async function handleAuditLog(
    session: VoiceSession,
    fx: SideEffect,
    tenantId: string,
  ): Promise<void> {
    if (!deps.auditRepo) {
      logger.debug('audit_log (no auditRepo wired)', {
        tenantId,
        payload: fx.payload,
      });
      return;
    }
    const eventType =
      typeof fx.payload.eventType === 'string'
        ? fx.payload.eventType
        : 'agent.calling.unknown';
    try {
      const ev = createAuditEvent({
        tenantId,
        actorId: deps.systemActorId ?? 'calling-agent',
        actorRole: 'system',
        eventType,
        entityType: 'voice_session',
        entityId: session.id,
        correlationId: session.id,
        metadata: fx.payload,
      });
      await deps.auditRepo.create(ev);
    } catch (err) {
      logger.warn('audit_log persist failed', {
        error: err instanceof Error ? err.message : String(err),
        sessionId: session.id,
      });
    }
  }

  async function handleCreateProposal(
    session: VoiceSession,
    fx: SideEffect,
    tenantId: string,
    sideEffectsSink: SideEffect[],
  ): Promise<void> {
    if (!deps.proposalRepo) {
      logger.info('create_proposal (no proposalRepo wired)', {
        tenantId,
        payload: fx.payload,
      });
      return;
    }
    const intent =
      typeof fx.payload.intent === 'string' ? fx.payload.intent : undefined;
    const entities =
      typeof fx.payload.entities === 'object' && fx.payload.entities !== null
        ? (fx.payload.entities as Record<string, unknown>)
        : {};
    try {
      const tenantThresholdOverride = await resolveThresholdOverride(tenantId);

      // N-003 (P2-036) — negotiation guardrail. The FSM emits this when the
      // caller pushes on price/scope/terms. Build the rich owner `callback`
      // (shared with the SMS + voice-action-router surfaces) and DO NOT dispatch
      // `proposal_queued`: the negotiation guard stays in the current state, so
      // a proposal_queued transition would be wrong here.
      if (intent === 'negotiation') {
        const askText = typeof entities.negotiationAsk === 'string' ? entities.negotiationAsk : '';
        const transcript = typeof entities.transcript === 'string' ? entities.transcript : '';
        const detectText = `${askText} ${transcript}`.trim();
        const customerName =
          typeof entities.customerName === 'string' ? entities.customerName : undefined;
        const conversationId =
          typeof fx.payload.conversationId === 'string' ? fx.payload.conversationId : undefined;
        const content = buildNegotiationCallbackContent({
          detectText,
          ...(askText ? { askText } : {}),
          ...(customerName ? { customerName } : {}),
          ...(conversationId ? { conversationId } : {}),
        });
        const negotiationProposal = buildProposal({
          tenantId,
          proposalType: 'callback',
          payload: content.payload,
          summary: content.summary,
          explanation: content.explanation,
          sourceContext: {
            source: 'calling-agent',
            channel: 'telephony',
            sessionId: session.id,
          },
          aiRunId: uuidv4(),
          createdBy:
            typeof fx.payload.customerId === 'string'
              ? fx.payload.customerId
              : deps.systemActorId ?? 'calling-agent',
          ...(tenantThresholdOverride ? { tenantThresholdOverride } : {}),
        });
        const storedNegotiation = await deps.proposalRepo.create(negotiationProposal);
        session.proposalIds.push(storedNegotiation.id);
        return;
      }

      const proposal = buildProposal({
        tenantId,
        proposalType: intentToProposalType(intent),
        payload: {
          intent,
          entities,
          sessionId: session.id,
          callSid: session.callSid,
        },
        summary: intent ? `Voice intent: ${intent}` : 'Voice clarification needed',
        sourceContext: {
          source: 'calling-agent',
          channel: 'telephony',
          sessionId: session.id,
        },
        aiRunId: uuidv4(),
        createdBy:
          typeof fx.payload.customerId === 'string'
            ? fx.payload.customerId
            : deps.systemActorId ?? 'calling-agent',
        ...(tenantThresholdOverride ? { tenantThresholdOverride } : {}),
      });
      const stored = await deps.proposalRepo.create(proposal);
      session.proposalIds.push(stored.id);
      const followUps = session.machine.dispatch({
        type: 'proposal_queued',
        proposalId: stored.id,
      });
      sideEffectsSink.push(...followUps);
    } catch (err) {
      logger.warn('create_proposal persist failed', {
        error: err instanceof Error ? err.message : String(err),
        sessionId: session.id,
      });
      const recovery = session.machine.dispatch({
        type: 'system_failure',
        reason: 'proposal_persist_failed',
      });
      sideEffectsSink.push(...recovery);
    }
  }

  function dialResultUrl(sessionId: string): string {
    const path = `/api/telephony/dial-result?sid=${encodeURIComponent(sessionId)}`;
    if (deps.publicBaseUrl) {
      return `${deps.publicBaseUrl.replace(/\/+$/, '')}${path}`;
    }
    return path;
  }

  async function handleNotifyOncall(
    session: VoiceSession,
    fx: SideEffect,
    tenantId: string,
  ): Promise<void> {
    if (!deps.onCallRepo || !deps.auditRepo) {
      logger.warn('notify_oncall (oncall/audit repos not wired)', {
        tenantId,
        payload: fx.payload,
      });
      return;
    }
    const rawReason =
      typeof fx.payload.reason === 'string' ? fx.payload.reason : 'low_confidence';
    const skillReason = mapNotifyReasonToSkillReason(rawReason);
    try {
      // F8: resolve per-tenant channel preferences for this escalation.
      let channelPreferences: { sms: boolean; in_app: boolean; whisper: boolean } = {
        sms: true,
        in_app: true,
        whisper: true,
      };
      // Voice-parity (Feature 7) — single warm-transfer line. When configured
      // it replaces the on-call rotation for this handoff.
      let transferNumber: string | undefined;
      if (deps.settingsRepo) {
        try {
          const tenantSettings = await deps.settingsRepo.findByTenant(tenantId);
          const escSettings = resolveEscalationSettings(tenantSettings);
          channelPreferences = {
            sms: escSettings.channel_sms,
            in_app: escSettings.channel_in_app,
            whisper: escSettings.channel_whisper,
          };
          transferNumber = tenantSettings?.transferNumber ?? undefined;
        } catch {
          // Best-effort: if settings lookup fails, fall back to all-enabled.
        }
      }

      const callerPhone =
        deps.callerPhoneResolver?.(session) ??
        (typeof fx.payload.callerPhone === 'string'
          ? fx.payload.callerPhone
          : 'unknown');

      const callerBundle = buildCallerContextFromSession(
        session,
        callerPhone,
        rawReason,
      );

      const result = await escalateToHuman({
        tenantId,
        sessionId: session.id,
        reason: skillReason,
        channel: 'telephony',
        onCallRepo: deps.onCallRepo,
        auditRepo: deps.auditRepo,
        session,
        ...(deps.callControl ? { callControl: deps.callControl } : {}),
        ...(deps.dispatcherPhoneResolver
          ? { dispatcherPhoneResolver: deps.dispatcherPhoneResolver }
          : {}),
        ...(transferNumber ? { transferNumber } : {}),
        ...(session.callSid ? { callSid: session.callSid } : {}),
        dialActionUrl: dialResultUrl(session.id),
        channelPreferences,
        buildSummary: buildEscalationSummary,
        callerContext: {
          caller: callerBundle.caller,
          customer: callerBundle.customer,
          intent: callerBundle.intent,
          transcriptSnapshot: callerBundle.transcriptSnapshot,
        },
        shopName: deps.businessName,
        ...(deps.publicBaseUrl ? { publicWebBaseUrl: deps.publicBaseUrl } : {}),
      });

      if (result.transfer) {
        const { transfer } = result;
        const escalationId = transfer.escalationId;
        const summary = transfer.summary;

        if (
          escalationId &&
          summary &&
          channelPreferences.whisper &&
          deps.whisperCache
        ) {
          deps.whisperCache.set(escalationId, summary.whisper);
        }

        if (
          channelPreferences.sms &&
          deps.deliveryProvider &&
          summary
        ) {
          const smsBody = summary.sms.replace('<escalationId>', escalationId ?? '');
          // Deliver the context SMS to the CSR BEFORE bridging — await provider
          // acceptance so the <Dial> TwiML isn't exposed first, but bound the
          // wait so a slow/hung provider can't hang the webhook. A send
          // failure (or the deadline) never blocks the transfer itself.
          const smsSend = deps.deliveryProvider
            .sendSms({ to: transfer.dispatcherPhone, body: smsBody })
            .catch((err) => {
              logger.warn('notify_oncall: SMS dispatch failed', {
                sessionId: session.id,
                error: err instanceof Error ? err.message : String(err),
              });
            });
          await Promise.race([
            smsSend,
            new Promise<void>((resolve) =>
              setTimeout(resolve, SMS_BEFORE_BRIDGE_TIMEOUT_MS),
            ),
          ]);
        }

        if (channelPreferences.in_app && escalationId && summary) {
          session.events.emit(
            VOICE_EVENT_CHANNEL,
            escalationStartedEvent({
              escalationId,
              reason: summary.panel.reason.code,
              dispatcherUserId: transfer.dispatcherUserId,
              tenantId,
              panel: summary.panel as unknown as PanelData,
            }),
          );
        }

        // fallbackTwiml is undefined when callControl was not wired (summary-only
        // path). Only populate the map when we have actual TwiML to emit.
        if (transfer.fallbackTwiml !== undefined) {
          pendingTransferTwiml.set(session.id, transfer.fallbackTwiml);
        }
        logger.info('notify_oncall: dialing dispatcher', {
          sessionId: session.id,
          rotationIndex: transfer.rotationIndex,
          dispatcherPhone: maskPhone(transfer.dispatcherPhone),
          hasSummary: Boolean(summary),
        });
      } else if (!result.escalated && deps.callControl) {
        await queueCallbackProposalInternal(
          session,
          tenantId,
          rawReason,
          'rotation_empty',
        );
        const safeName = xmlEscape(deps.businessName);
        pendingTransferTwiml.set(
          session.id,
          `<?xml version="1.0" encoding="UTF-8"?>` +
            `<Response>` +
            `<Say voice="Polly.Joanna">I'm sorry, no one is available right now. ${safeName} will call you back as soon as possible. Thank you for calling.</Say>` +
            `<Hangup/>` +
            `</Response>`,
        );
        session.ended = true;
      }
    } catch (err) {
      logger.warn('escalateToHuman failed', {
        error: err instanceof Error ? err.message : String(err),
        sessionId: session.id,
      });
    }
  }

  /**
   * Internal duplicate of the adapter's `queueCallbackProposal` used by
   * `handleNotifyOncall` when the rotation cascade is empty. The adapter
   * retains its public `queueCallbackProposal` for the route layer; both
   * paths build the same proposal shape.
   */
  async function queueCallbackProposalInternal(
    session: VoiceSession,
    tenantId: string,
    reason: string,
    outcome: 'rotation_empty' | 'rotation_exhausted',
  ): Promise<void> {
    if (!deps.proposalRepo) {
      logger.warn('queueCallbackProposal: proposalRepo not wired', {
        sessionId: session.id,
        outcome,
      });
      return;
    }
    try {
      const tenantThresholdOverride = await resolveThresholdOverride(tenantId);
      const proposal = buildProposal({
        tenantId,
        proposalType: 'voice_clarification',
        payload: {
          intent: 'customer_callback_required',
          reason,
          outcome,
          sessionId: session.id,
          callSid: session.callSid,
        },
        summary: `Customer callback required (${outcome})`,
        sourceContext: {
          source: 'calling-agent',
          channel: 'telephony',
          sessionId: session.id,
          escalationReason: reason,
        },
        aiRunId: uuidv4(),
        createdBy: deps.systemActorId ?? 'calling-agent',
        ...(tenantThresholdOverride ? { tenantThresholdOverride } : {}),
      });
      const stored = await deps.proposalRepo.create(proposal);
      session.proposalIds.push(stored.id);
      if (deps.auditRepo) {
        try {
          const auditEvent = createAuditEvent({
            tenantId,
            actorId: deps.systemActorId ?? 'calling-agent',
            actorRole: 'system',
            eventType: 'customer_callback_required',
            entityType: 'voice_session',
            entityId: session.id,
            correlationId: session.id,
            metadata: {
              proposalId: stored.id,
              reason,
              outcome,
              callSid: session.callSid,
            },
          });
          await deps.auditRepo.create(auditEvent);
        } catch (err) {
          logger.warn('queueCallbackProposal: audit persist failed', {
            error: err instanceof Error ? err.message : String(err),
            sessionId: session.id,
          });
        }
      }
      deps.callControl?.clearCursor(session.id);
    } catch (err) {
      logger.warn('queueCallbackProposal failed', {
        error: err instanceof Error ? err.message : String(err),
        sessionId: session.id,
      });
    }
  }

  async function executeSideEffects(
    session: VoiceSession,
    sideEffects: SideEffect[],
    tenantId: string,
  ): Promise<void> {
    if (sideEffects.length > 0) {
      deps.store.touch(session.id);
    }
    for (const fx of sideEffects) {
      if (fx.type === 'audit_log') {
        await handleAuditLog(session, fx, tenantId);
      } else if (fx.type === 'create_proposal') {
        await handleCreateProposal(session, fx, tenantId, sideEffects);
      } else if (fx.type === 'notify_oncall') {
        await handleNotifyOncall(session, fx, tenantId);
      }
    }
  }

  // ─── Outcome / persistence ──────────────────────────────────────────

  async function persistSessionEnded(
    session: VoiceSession,
    endedReason: string,
    outcome: CallOutcome,
  ): Promise<void> {
    if (!deps.voiceSessionRepo) return;
    try {
      await deps.voiceSessionRepo.markEnded(session.tenantId, session.id, {
        endedAt: new Date(),
        endedReason,
        outcome,
        state: session.machine.currentState,
        channel:
          session.channel === 'telephony' ? 'voice_inbound' : 'inapp_voice',
        ...(session.callSid !== undefined ? { callSid: session.callSid } : {}),
        // 15.8/15.9 — persist the in-memory transcript so /api/interactions
        // can surface the full conversation without relying on the
        // process-scoped VoiceSessionStore. (Mirrors the adapter's
        // legacy persistSessionEnded; that path is now bypassed because
        // the processor sets terminalOutcome first, so without these
        // fields transcript+customerId were silently dropped from
        // voice_sessions for any session ending via the extracted
        // speechTurn.)
        ...(session.transcript.length > 0
          ? { transcript: [...session.transcript] }
          : {}),
        // Stamp the customer FK so the interactions list can join to
        // the customers table and surface the linked customer.
        ...(session.customerId !== undefined
          ? { customerId: session.customerId }
          : {}),
      });
    } catch {
      /* swallow — outcome stamping is best-effort */
    }
  }

  function finalizeTerminatedSession(
    session: VoiceSession,
    sideEffects: ReadonlyArray<SideEffect>,
    fallbackReason: string,
  ): void {
    if (session.terminalOutcome) return;
    const endSessionEffect = [...sideEffects]
      .reverse()
      .find((e) => e.type === 'end_session');
    const reason =
      (endSessionEffect && typeof endSessionEffect.payload.reason === 'string'
        ? endSessionEffect.payload.reason
        : undefined) ?? fallbackReason;
    const outcome = deriveCallOutcome({
      finalState: session.machine.currentState,
      endedReason: reason,
      context: session.machine.currentContext,
      transcript: session.transcript,
      proposalIds: session.proposalIds,
    });
    session.terminalOutcome = outcome;
    session.terminalReason = reason;
    void persistSessionEnded(session, reason, outcome);

    if (
      outcome === 'dropped' &&
      deps.deliveryProvider &&
      deps.callerPhoneResolver &&
      session.channel === 'telephony'
    ) {
      const callerE164 = deps.callerPhoneResolver(session);
      if (callerE164 && callerE164.length >= 7) {
        scheduleDroppedCallRecovery({
          tenantId: session.tenantId,
          sessionId: session.id,
          callerE164,
          shopName: deps.businessName,
          sendSms: (args) => deps.deliveryProvider!.sendSms(args),
        });
      }
    }
  }

  async function runSummary(session: VoiceSession): Promise<void> {
    const durationMs = Date.now() - session.createdAt.getTime();

    if (session.transcript.length === 0) {
      logger.info('runSummary: skipping (empty transcript)', {
        sessionId: session.id,
      });
    } else {
      const intentDetected = session.machine.currentContext.currentIntent;
      const SUMMARY_RETRY_DELAYS_MS = [200, 800];
      let lastErr: unknown = null;
      for (let attempt = 0; attempt <= SUMMARY_RETRY_DELAYS_MS.length; attempt++) {
        try {
          await summarizeSession({
            tenantId: session.tenantId,
            sessionId: session.id,
            transcript: session.transcript,
            proposalIds: session.proposalIds,
            durationMs,
            gateway: deps.gateway,
            ...(intentDetected ? { intentDetected } : {}),
            ...(deps.pool ? { pool: deps.pool } : {}),
          });
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err;
          if (attempt < SUMMARY_RETRY_DELAYS_MS.length) {
            await new Promise((r) => {
              const t = setTimeout(r, SUMMARY_RETRY_DELAYS_MS[attempt]);
              if (typeof t.unref === 'function') t.unref();
            });
          }
        }
      }
      if (lastErr) {
        logger.warn('summarizeSession failed after retries', {
          error: lastErr instanceof Error ? lastErr.message : String(lastErr),
          sessionId: session.id,
          attempts: SUMMARY_RETRY_DELAYS_MS.length + 1,
        });
      }
    }

    const callSid = session.machine.currentContext.callSid;
    if (deps.voiceRepo?.stampOutcomeByCallSid && callSid) {
      try {
        await deps.voiceRepo.stampOutcomeByCallSid(
          session.tenantId,
          callSid,
          deriveOutcomeFromSession(session),
        );
      } catch (err) {
        logger.warn('stampOutcomeByCallSid failed', {
          error: err instanceof Error ? err.message : String(err),
          callSid,
        });
      }
    }
  }

  /**
   * Local duplicate of the adapter's `deriveCallOutcome` for use inside
   * `runSummary`. The adapter retains its own (used by
   * `stampCallOutcomeByCallSid`); both branches return the same value
   * for the same session.
   */
  function deriveOutcomeFromSession(session: VoiceSession): CallOutcome {
    const ctx = session.machine.currentContext;
    if (ctx.escalationReason) {
      if (ctx.escalationReason.startsWith('system_failure')) return 'failed';
      if (ctx.escalationReason.startsWith('cost_cap_exceeded')) return 'failed';
      if (ctx.escalationReason.startsWith('callback_required'))
        return 'callback_required';
      if (ctx.escalationReason.startsWith('abuse_detected')) return 'failed';
      return 'escalated_to_human';
    }
    if (session.proposalIds.length > 0) return 'completed';
    if (ctx.currentIntent && ctx.currentIntent !== 'unknown') return 'completed';
    const hadCallerSpeech = session.transcript.some((line) =>
      line.startsWith('caller:'),
    );
    if (!hadCallerSpeech) return 'dropped';
    return 'no_intent';
  }

  // ─── RV-071 — owner voice-approval dialogue ─────────────────────────

  /** Assembled lazily — voice approval needs a proposalRepo to exist. */
  function voiceApprovalDeps(): VoiceApprovalDeps | null {
    if (!deps.proposalRepo) return null;
    return {
      proposalRepo: deps.proposalRepo,
      ...(deps.auditRepo ? { auditRepo: deps.auditRepo } : {}),
      ...(deps.settingsRepo ? { settingsRepo: deps.settingsRepo } : {}),
      ...(deps.smsEventRepo ? { smsEventRepo: deps.smsEventRepo } : {}),
      ...(deps.appointmentRepo ? { appointmentRepo: deps.appointmentRepo } : {}),
      ...(deps.voiceApprovalOneTap ? { oneTapFallback: deps.voiceApprovalOneTap } : {}),
      // RV-225 — the voice edit dialogue interprets deltas through the
      // SAME LLM seam as the SMS EDIT reply (proposals/edit-interpreter.ts).
      editInterpreter: createLlmEditInterpreter(deps.gateway),
    };
  }

  function applyVoiceApprovalResult(
    session: VoiceSession,
    result: VoiceApprovalTurnResult,
  ): SideEffect[] {
    session.pendingVoiceApproval = result.pending ?? undefined;
    // Merge (never replace) session-level mutations: a turn that only
    // bumps challengeFailCount must not drop an earlier challengeLockedOut.
    if (result.sessionState) {
      session.voiceApprovalState = {
        ...session.voiceApprovalState,
        ...result.sessionState,
      };
    }
    return [{ type: 'tts_play', payload: { text: result.speak, source: 'voice_approval' } }];
  }

  async function handlePendingVoiceApproval(
    session: VoiceSession,
    speechResult: string,
    tenantId: string,
  ): Promise<SideEffect[] | null> {
    const pending = session.pendingVoiceApproval;
    if (!pending) return null;
    const approvalDeps = voiceApprovalDeps();
    if (!approvalDeps) {
      session.pendingVoiceApproval = undefined;
      return null;
    }
    const result = await continueVoiceApproval(approvalDeps, {
      tenantId,
      sessionId: session.id,
      ownerSession: session.machine.currentContext.ownerSession === true,
      // Session-level lockout / fail-counter state — without this the
      // challenge lockout is dead code (the task can't see prior failures).
      sessionState: session.voiceApprovalState,
      utterance: speechResult,
      pending,
    });
    return applyVoiceApprovalResult(session, result);
  }

  async function handleVoiceApprovalIntent(
    session: VoiceSession,
    args: {
      intentType: string;
      entities: Record<string, unknown>;
      utterance: string;
      tenantId: string;
    },
  ): Promise<SideEffect[]> {
    const ownerSession = session.machine.currentContext.ownerSession === true;
    const approvalDeps = ownerSession ? voiceApprovalDeps() : null;

    // The HARD gate (never prompt-only): a non-owner caller uttering
    // "approve ..." — or a deployment without a proposalRepo — never
    // starts an approval flow. The FSM's bounded reprompt path answers.
    if (!ownerSession || !approvalDeps) {
      const sideEffects: SideEffect[] = [
        {
          type: 'audit_log',
          payload: {
            eventType: 'agent.calling.voice_approval_denied',
            reason: ownerSession ? 'not_configured' : 'not_owner_session',
            intentType: args.intentType,
            sessionId: session.id,
            tenantId: args.tenantId,
            ts: Date.now(),
          },
        },
      ];
      sideEffects.push(
        ...session.machine.dispatch({ type: 'confidence_low', threshold: TAU_INT, score: 0 }),
      );
      return sideEffects;
    }

    const reference =
      typeof args.entities.proposalReference === 'string' &&
      args.entities.proposalReference.trim().length > 0
        ? args.entities.proposalReference
        : args.utterance;
    const result = await startVoiceApproval(approvalDeps, {
      tenantId: args.tenantId,
      sessionId: session.id,
      ownerSession,
      // Session-level lockout state: a locked session refuses fresh
      // money/irreversible dialogues immediately (capture-class still works).
      sessionState: session.voiceApprovalState,
      action: args.intentType === 'reject_proposal' ? 'reject' : 'approve',
      reference,
    });
    // The FSM deliberately stays in intent_capture / closing (the
    // lookup-skill pattern): the dialogue is session-scoped adapter
    // state, so existing FSM flows are untouched.
    return applyVoiceApprovalResult(session, result);
  }

  /**
   * RV-225 — owner voice edit ("change the second line to $200"). Same
   * layered gating as approve/reject: the classifier only sees the intent
   * on an owner session (prompt section), and this handler HARD-gates on
   * ownerSession + a wired proposalRepo — a non-owner "change ..." gets
   * the normal bounded reprompt, never an edit.
   */
  async function handleVoiceEditIntent(
    session: VoiceSession,
    args: {
      entities: Record<string, unknown>;
      utterance: string;
      tenantId: string;
    },
  ): Promise<SideEffect[]> {
    const ownerSession = session.machine.currentContext.ownerSession === true;
    const approvalDeps = ownerSession ? voiceApprovalDeps() : null;

    if (!ownerSession || !approvalDeps) {
      const sideEffects: SideEffect[] = [
        {
          type: 'audit_log',
          payload: {
            eventType: 'agent.calling.voice_edit_denied',
            reason: ownerSession ? 'not_configured' : 'not_owner_session',
            intentType: 'edit_proposal',
            sessionId: session.id,
            tenantId: args.tenantId,
            ts: Date.now(),
          },
        },
      ];
      sideEffects.push(
        ...session.machine.dispatch({ type: 'confidence_low', threshold: TAU_INT, score: 0 }),
      );
      return sideEffects;
    }

    const reference =
      typeof args.entities.proposalReference === 'string' &&
      args.entities.proposalReference.trim().length > 0
        ? args.entities.proposalReference
        : args.utterance;
    const instruction =
      typeof args.entities.editInstruction === 'string' &&
      args.entities.editInstruction.trim().length > 0
        ? args.entities.editInstruction
        : args.utterance;
    const result = await startVoiceEdit(approvalDeps, {
      tenantId: args.tenantId,
      sessionId: session.id,
      ownerSession,
      sessionState: session.voiceApprovalState,
      reference,
      instruction,
    });
    return applyVoiceApprovalResult(session, result);
  }

  // ─── Speech turn (formerly processCallerUtterance) ──────────────────

  const speechTurn: SpeechTurnHandler = async ({
    session,
    speechResult,
    callSid: _callSid,
    tenantId,
  }): Promise<SideEffect[]> => {
    // Note: `processCallerUtterance` historically took `sessionId` and
    // looked up the session via the store. The mediastream adapter
    // already resolves the session before invoking us, so we accept it
    // directly. The unknown-session fallback is preserved for the
    // (rare) case where callers pass through a stale session.
    if (!session) {
      logger.warn('speechTurn: missing session');
      return [
        {
          type: 'tts_play',
          payload: {
            text: "I'm sorry, your session has ended. Please call again.",
          },
        },
        { type: 'end_session', payload: { reason: 'session_not_found' } },
      ];
    }

    // 1. Append caller utterance to transcript.
    deps.store.appendTranscript(session.id, {
      speaker: 'caller',
      text: speechResult,
      ts: Date.now(),
    });

    // RV-071 — an in-flight owner approval dialogue consumes the turn
    // BEFORE the FSM-state branch (including silence: an empty utterance
    // is "anything else" → no action, keep for later).
    const approvalTurn = await handlePendingVoiceApproval(session, speechResult, tenantId);
    if (approvalTurn) {
      await executeSideEffects(session, approvalTurn, tenantId);
      appendAgentTts(deps.store, session.id, approvalTurn);
      return approvalTurn;
    }

    const sideEffectsAll: SideEffect[] = [];
    const currentState = session.machine.currentState;

    if (speechResult.trim().length === 0) {
      sideEffectsAll.push(
        ...session.machine.dispatch({
          type: 'confidence_low',
          threshold: TAU_INT,
          score: 0,
        }),
      );
      await executeSideEffects(session, sideEffectsAll, tenantId);
      return sideEffectsAll;
    }

    if (currentState === 'intent_confirm') {
      try {
        const ctx = session.machine.currentContext;
        const intentSummary = ctx.currentIntent ?? 'that';
        const confirmation = await confirmIntent({
          intentSummary,
          callerResponse: speechResult,
          tenantId,
          gateway: deps.gateway,
        });
        const capExceeded = recordCost(session, confirmation.tokenUsage);
        if (capExceeded) {
          sideEffectsAll.push(
            ...session.machine.dispatch({ type: 'cost_cap_exceeded' }),
          );
        } else if (confirmation.confirmed) {
          sideEffectsAll.push(
            ...session.machine.dispatch({ type: 'confirmed' }),
          );
        } else {
          sideEffectsAll.push(
            ...session.machine.dispatch({
              type: 'correction',
              newTranscript: confirmation.correction ?? speechResult,
            }),
          );
        }
      } catch (err) {
        logger.error('speechTurn: confirmIntent failed', {
          error: err instanceof Error ? err.message : String(err),
          sessionId: session.id,
        });
        sideEffectsAll.push(
          ...session.machine.dispatch({
            type: 'correction',
            newTranscript: speechResult,
          }),
        );
      }
    } else if (currentState === 'intent_capture' || currentState === 'closing') {
      let classifierEvent: CallingAgentEvent | null = null;
      const verticalPromptSection = await resolveVerticalPromptSection(tenantId);
      const planPromptSection = await resolvePlanPromptSection(
        tenantId,
        session.customerId,
      );
      try {
        const classification = await classifyIntent(
          speechResult,
          {
            tenantId,
            verticalPromptSection,
            planPromptSection,
            // RV-071 — the owner-approval prompt section is appended ONLY
            // on a recognized owner line (caller-ID match; see
            // approver-identity.ts), keeping every other call's
            // prompt byte-identical (cassettes / gateway cache).
            ...(session.machine.currentContext.ownerSession === true
              ? { ownerSession: true }
              : {}),
          },
          deps.gateway,
        );
        session.events.emit(
          'voice-event',
          intentClassifiedEvent({
            intentType: classification.intentType,
            confidence: classification.confidence,
            tokenUsage: classification.tokenUsage,
          }),
        );
        const capExceeded = recordCost(session, classification.tokenUsage);
        if (capExceeded) {
          classifierEvent = { type: 'cost_cap_exceeded' };
        } else if (
          classification.confidence >= TAU_INT &&
          classification.intentType !== 'unknown'
        ) {
          classifierEvent = {
            type: 'intent_classified',
            intentType: classification.intentType,
            entities: (classification.extractedEntities ?? {}) as Record<
              string,
              unknown
            >,
            confidence: classification.confidence,
          };
        } else {
          classifierEvent = {
            type: 'confidence_low',
            threshold: TAU_INT,
            score: classification.confidence,
          };
        }
      } catch (err) {
        logger.error('speechTurn: classifyIntent failed', {
          error: err instanceof Error ? err.message : String(err),
          sessionId: session.id,
        });
        classifierEvent = { type: 'confidence_low', threshold: TAU_INT, score: 0 };
      }

      // RV-071 — owner voice approval. Routed OUTSIDE the FSM (the
      // lookup-skill pattern: the FSM state is untouched and the dialogue
      // lives on the session). handleVoiceApprovalIntent hard-gates on
      // ownerSession — a non-owner "approve" gets the normal reprompt.
      if (
        classifierEvent.type === 'intent_classified' &&
        isVoiceApprovalIntent(classifierEvent.intentType)
      ) {
        const approvalFx = await handleVoiceApprovalIntent(session, {
          intentType: classifierEvent.intentType,
          entities: classifierEvent.entities,
          utterance: speechResult,
          tenantId,
        });
        sideEffectsAll.push(...approvalFx);
        await executeSideEffects(session, sideEffectsAll, tenantId);
        appendAgentTts(deps.store, session.id, sideEffectsAll);
        return sideEffectsAll;
      }

      // RV-225 — owner voice edit. Same out-of-FSM routing as the approval
      // dialogue; handleVoiceEditIntent hard-gates on ownerSession.
      if (
        classifierEvent.type === 'intent_classified' &&
        isVoiceEditIntent(classifierEvent.intentType)
      ) {
        const editFx = await handleVoiceEditIntent(session, {
          entities: classifierEvent.entities,
          utterance: speechResult,
          tenantId,
        });
        sideEffectsAll.push(...editFx);
        await executeSideEffects(session, sideEffectsAll, tenantId);
        appendAgentTts(deps.store, session.id, sideEffectsAll);
        return sideEffectsAll;
      }

      // P12-004 — emergency-intent immediate Dial. When the classified
      // intent is in the emergency set AND the tenant is unsupervised
      // (checked inside the wrapper via isSupervisorPresent), bypass the
      // FSM/booking path entirely and Dial the on-call rotation now.
      // The wrapper emits the `emergency_immediate_dial` audit event.
      // Supervised tenants and non-emergency intents fall through to the
      // unchanged FSM dispatch below.
      if (
        classifierEvent.type === 'intent_classified' &&
        EMERGENCY_INTENTS.has(classifierEvent.intentType) &&
        deps.onCallRepo
      ) {
        try {
          const immediate = await emergencyImmediateDial({
            intent: classifierEvent.intentType,
            tenantId,
            sessionId: session.id,
            channel: 'telephony',
            onCallRepo: deps.onCallRepo,
            ...(deps.auditRepo ? { auditRepo: deps.auditRepo } : {}),
            session,
            ...(deps.callControl ? { callControl: deps.callControl } : {}),
            ...(deps.dispatcherPhoneResolver
              ? { dispatcherPhoneResolver: deps.dispatcherPhoneResolver }
              : {}),
            ...(session.callSid ? { callSid: session.callSid } : {}),
            dialActionUrl: dialResultUrl(session.id),
          });
          if (immediate.dialed && immediate.escalation) {
            if (immediate.escalation.transfer?.fallbackTwiml !== undefined) {
              pendingTransferTwiml.set(
                session.id,
                immediate.escalation.transfer.fallbackTwiml,
              );
            }
            sideEffectsAll.push({
              type: 'tts_play',
              payload: { text: immediate.escalation.message },
            });
            await executeSideEffects(session, sideEffectsAll, tenantId);
            return sideEffectsAll;
          }
        } catch (err) {
          // Best-effort: an immediate-Dial failure must never strand the
          // caller — fall through to the normal FSM path (whose own
          // emergency fast-path still escalates via notify_oncall).
          logger.warn('speechTurn: emergencyImmediateDial failed, falling through', {
            error: err instanceof Error ? err.message : String(err),
            sessionId: session.id,
          });
        }
      }

      sideEffectsAll.push(...session.machine.dispatch(classifierEvent));

      if (
        classifierEvent.type === 'intent_classified' &&
        session.machine.currentState === 'entity_resolution'
      ) {
        const refs: Record<string, string> = {};
        for (const [k, v] of Object.entries(classifierEvent.entities)) {
          if (typeof v === 'string') refs[k] = v;
        }
        sideEffectsAll.push(
          ...session.machine.dispatch({ type: 'entity_resolved', refs }),
        );
        expandIntentConfirmTemplate(sideEffectsAll, classifierEvent.intentType);
      }
    } else {
      logger.info('speechTurn: unhandled state, treating as confidence_low', {
        state: currentState,
        sessionId: session.id,
      });
      sideEffectsAll.push(
        ...session.machine.dispatch({
          type: 'confidence_low',
          threshold: TAU_INT,
          score: 0,
        }),
      );
    }

    await executeSideEffects(session, sideEffectsAll, tenantId);

    appendAgentTts(deps.store, session.id, sideEffectsAll);
    if (session.machine.currentState === 'terminated' && !session.ended) {
      session.ended = true;
      finalizeTerminatedSession(session, sideEffectsAll, 'caller_hangup');
      // Defer summary kick-off to the host so it can decide on retry /
      // background semantics. We `await` the callback so hosts that
      // need summary spend to land within a snapshot window (Layer 2
      // entry test) can do so deterministically; production keeps the
      // fire-and-forget tradeoff inside its callback wiring to preserve
      // Twilio webhook latency. When no host hook is wired we run
      // summary inline (still fire-and-forget) for parity with the
      // adapter's legacy behavior.
      if (deps.onSessionTerminated) {
        try {
          await deps.onSessionTerminated(session);
        } catch (err) {
          logger.warn('onSessionTerminated callback threw', {
            error: err instanceof Error ? err.message : String(err),
            sessionId: session.id,
          });
        }
      } else {
        void runSummary(session).catch(() => {
          /* swallow — summary is best-effort */
        });
      }
    }

    return sideEffectsAll;
  };

  return {
    speechTurn,
    finalizeTerminatedSession,
    executeSideEffects,
    recordCost,
    expandIntentConfirmTemplate,
    resolveVerticalPromptSection,
    resolvePlanPromptSection,
    resolveThresholdOverride,
    runSummary,
    handlePendingVoiceApproval,
    handleVoiceApprovalIntent,
    handleVoiceEditIntent,
  };
}
