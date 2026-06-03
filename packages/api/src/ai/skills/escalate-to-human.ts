import { v4 as uuidv4 } from 'uuid';
import { createAuditEvent } from '../../audit/audit';
import type { AuditRepository } from '../../audit/audit';
import type { OnCallRepository } from '../../oncall/rotation';
import type { TwilioCallControl } from '../../telephony/twilio-call-control';
import { t, type Language } from '../i18n/i18n';
import type { VoiceSession } from '../agents/customer-calling/voice-session-store';
import {
  escalationTriggeredEvent,
} from '../voice-quality/events';
import { VOICE_EVENT_CHANNEL } from '../voice-quality/event-bus';
import type { EscalationSummary, EscalationContext } from '../agents/customer-calling/escalation-summary-builder';

/**
 * Phase 12 — emergency-intent immediate-Dial decision.
 *
 * When an emergency intent is detected mid-call AND the tenant is
 * unsupervised AND the channel is voice (telephony), the AI gateway
 * should skip proposal generation entirely and route the call straight
 * through `escalateToHuman` with `reason='emergency_dispatch'`.
 *
 * This helper centralizes the predicate so call sites (intent classifier
 * branch, voice-action-router) consult it instead of duplicating logic.
 * It is intentionally a pure function — no I/O, no side effects.
 *
 * Returns `true` when the call site should bypass the normal AI path
 * and invoke `escalateToHuman` immediately. Returns `false` for any
 * non-emergency intent, any in-app channel (no Twilio Dial available),
 * or any tenant that has at least one supervisor present.
 *
 * Note on intent: the existing intent classifier emits free-form
 * intent strings. The "emergency set" is the small list of intents
 * that signal customer harm potential — burst pipe, gas leak, no
 * heat in winter, no AC in extreme heat. We accept the set as input
 * (via `EMERGENCY_INTENTS`) so the classifier remains the source of
 * truth and this helper stays presentation-agnostic.
 */
export const EMERGENCY_INTENTS: ReadonlySet<string> = new Set([
  'emergency_plumbing',
  'emergency_hvac',
  'emergency_dispatch',
  'gas_leak',
  'burst_pipe',
  'no_heat',
  'no_ac',
]);

export interface ImmediateDialDecisionInput {
  /** Free-form intent string from the classifier. */
  intent: string;
  /**
   * Tenant-wide supervisor presence (from `isSupervisorPresent`).
   * `true` means at least one user is in 'supervisor' or 'both' mode.
   */
  supervisorPresent: boolean;
  /**
   * Channel of the active conversation. Only 'telephony' supports
   * Twilio `<Dial>`; in-app voice falls back to the existing
   * escalate-to-human in-app path.
   */
  channel: 'telephony' | 'inapp';
}

export function shouldImmediatelyDialOnEmergency(
  input: ImmediateDialDecisionInput,
): boolean {
  if (!EMERGENCY_INTENTS.has(input.intent)) return false;
  if (input.supervisorPresent === true) return false;
  if (input.channel !== 'telephony') return false;
  return true;
}

export type EscalationReason =
  | 'caller_requested'
  | 'low_confidence'
  | 'cost_cap_exceeded'
  | 'emergency_dispatch'
  | 'abuse_detected'
  | 'provider_failure'
  | 'max_retries_exceeded'
  // P8-016 — vulnerability-aware emergency patch to the OWNER's cell (a
  // separate path from the dispatcher rotation). Additive; existing reasons
  // are unchanged.
  | 'vulnerability_patch';

/**
 * Maps the skill-layer EscalationReason (internal system categorisation)
 * to the builder-layer EscalationContext['reason'] (dispatcher-facing UX
 * vocabulary). The two unions describe different things: the skill captures
 * *why the system decided to escalate*; the builder captures *what to tell
 * the dispatcher*. They overlap only on `emergency_dispatch`.
 *
 * Exported for unit-testing.
 */
export function mapSkillReasonToBuilderReason(
  reason: EscalationReason,
): EscalationContext['reason'] {
  switch (reason) {
    case 'emergency_dispatch':
    // P8-016 — a vulnerability patch IS an emergency from the human's POV;
    // surface it with the emergency vocabulary.
    case 'vulnerability_patch':
      return 'emergency_dispatch';
    case 'caller_requested':
      return 'operator_request';
    case 'low_confidence':
    case 'max_retries_exceeded':
      return 'low_confidence_intent';
    case 'cost_cap_exceeded':
    case 'abuse_detected':
    case 'provider_failure':
      // No semantically clean dispatcher-facing reason for these;
      // group with low_confidence_intent so the dispatcher knows the AI
      // gave up rather than the caller demanding a human.
      return 'low_confidence_intent';
  }
}

/**
 * Resolve a dispatcher's outbound phone number.
 *
 * The on-call rotation table only carries `userId`; today there is no
 * `users.phone` column, so a separate resolver is injected. v1 wiring
 * pulls the number from a small env-driven map; a follow-up will join
 * a real user_phones table once the schema lands. Returning null means
 * "no phone available" — the caller should advance to the next
 * rotation entry rather than `<Dial>` an empty number.
 */
export type DispatcherPhoneResolver = (
  tenantId: string,
  userId: string,
) => Promise<string | null>;

/**
 * P8-016 — resolve the TENANT OWNER's cell phone (E.164) for a vulnerability
 * patch. Sibling to `DispatcherPhoneResolver` but a SEPARATE path: it pages the
 * owner directly (tenants.owner_id → that user's `mobileNumber`), bypassing the
 * dispatcher rotation. Returns null when no owner mobile is on file — the
 * caller (`owner-cell-patch`) then falls back to a high-priority booking + SMS.
 */
export type OwnerPhoneResolver = (tenantId: string) => Promise<string | null>;

export interface EscalateToHumanInput {
  tenantId: string;
  conversationId?: string;
  sessionId: string;
  reason: EscalationReason;
  channel: 'telephony' | 'inapp';
  callerPhone?: string;
  emergencyDescription?: string;
  onCallRepo: OnCallRepository;
  auditRepo?: AuditRepository;
  /**
   * Telephony only. When set, the skill emits a `transfer` descriptor
   * the Twilio adapter consumes to render `<Dial>`. In-app callers
   * leave this undefined and behave exactly as before (no transfer
   * field in the result).
   */
  callControl?: TwilioCallControl;
  /**
   * Telephony only. Resolves a rotation entry's userId to the
   * dispatcher's phone number. Required when `callControl` is set
   * AND the caller wants the skill to walk the rotation; without it
   * the skill falls back to the v1 in-app behavior even on telephony.
   */
  dispatcherPhoneResolver?: DispatcherPhoneResolver;
  /**
   * P8-016 — telephony only. Resolves the tenant OWNER's cell for a
   * `vulnerability_patch`. Optional; consumed by `owner-cell-patch`, not by
   * the default escalation branches. Present here so the input shape stays the
   * single carrier for telephony resolvers.
   */
  ownerPhoneResolver?: OwnerPhoneResolver;
  /**
   * Telephony only. Twilio CallSid of the active call leg. Required
   * for `callControl.dialDispatcher` to bind the `<Dial>` to the
   * right call. Falls back to `sessionId` when omitted (less precise
   * but enough for tests).
   */
  callSid?: string;
  /**
   * Telephony only. Absolute URL Twilio POSTs once the `<Dial>` verb
   * completes. Required when `callControl` is set.
   */
  dialActionUrl?: string;
  /** P11-002: spoken-message language. Defaults to 'en'. */
  language?: Language;
  /**
   * VQ-003: optional live session reference. When supplied, the skill
   * emits an `escalation_triggered` event on the session's emitter
   * once the escalation is committed (telephony transfer initiated OR
   * in-app dispatcher assigned). Left undefined for callers that
   * don't have a session in scope; pre-VQ-003 behavior is preserved.
   */
  session?: VoiceSession;
  /**
   * F1 wiring: optional callback that produces a structured
   * `EscalationSummary` (whisper / SMS / panel) from FSM context.
   * When provided alongside `callerContext`, the skill generates an
   * `escalationId` and calls this once; the result is included in the
   * returned `TransferDescriptor`. Optional — existing callers that
   * don't supply it continue to work unchanged.
   */
  buildSummary?: (ctx: EscalationContext) => EscalationSummary;
  /**
   * F1 wiring: minimal FSM context needed to build an escalation
   * summary. Required when `buildSummary` is set; ignored otherwise.
   */
  callerContext?: {
    caller: EscalationContext['caller'];
    customer?: EscalationContext['customer'];
    intent: EscalationContext['intent'];
    transcriptSnapshot: EscalationContext['transcriptSnapshot'];
  };
  /**
   * F1 wiring: tenant's trading name, included in whisper/SMS output.
   * Defaults to `'Our shop'` when `buildSummary` is set but `shopName`
   * is omitted.
   */
  shopName?: string;
  /**
   * F8 — per-tenant channel flags. When absent, all three channels
   * default to enabled (matches pre-F8 single-channel behavior).
   */
  channelPreferences?: { sms: boolean; in_app: boolean; whisper: boolean };
  /**
   * Public web app base URL used to build the SMS short-link in the
   * escalation summary. Passed through to `EscalationContext.publicWebBaseUrl`.
   * Defaults to `process.env.PUBLIC_WEB_URL` (or `app.fieldly.app` as last resort).
   */
  publicWebBaseUrl?: string;
}

/**
 * Telephony-only descriptor returned alongside the standard
 * EscalationResult fields when the skill picked a dispatcher and the
 * adapter should bridge the call. The adapter writes
 * `transfer.fallbackTwiml` directly into its webhook response.
 */
export interface TransferDescriptor {
  /** E.164 phone number to dial. Treat as PII — never log raw. */
  dispatcherPhone: string;
  /**
   * Complete `<Response>` TwiML the adapter should hand back to
   * Twilio. Built via `TwilioCallControl.dialDispatcher`.
   * `undefined` when `callControl` was not wired (summary-only path) —
   * the adapter MUST NOT send an empty string to Twilio (400 error).
   */
  fallbackTwiml: string | undefined;
  /** Rotation entry that produced this transfer. */
  rotationEntryId: string;
  /** Dispatcher's userId (FK to users.id). */
  dispatcherUserId: string;
  /** Zero-based index into the rotation that was dialed. */
  rotationIndex: number;
  /**
   * F1 wiring: structured summary produced by `buildSummary` callback.
   * Present when the caller supplied both `buildSummary` and
   * `callerContext` on `EscalateToHumanInput`. Undefined otherwise.
   */
  summary?: EscalationSummary;
  /**
   * F1 wiring: opaque ID that ties the whisper webhook, SMS deep-link,
   * and in-app panel to this specific escalation. Generated at the time
   * `buildSummary` is called. Undefined when no summary was built.
   */
  escalationId?: string;
  /**
   * F8 — channel preferences threaded from per-tenant escalation settings.
   * The adapter fan-out handler reads this to skip disabled channels.
   * Defaults to all-enabled when absent.
   */
  channelPreferences: { sms: boolean; in_app: boolean; whisper: boolean };
}

export interface EscalationResult {
  escalated: boolean;
  assignedUserId?: string;
  /** For in-app: show "Connecting you with [dispatcher name]" */
  message: string;
  /** For emergency_dispatch: a proposal was queued */
  proposalId?: string;
  /**
   * Telephony-only. Present when `callControl` was provided AND the
   * skill found a dispatcher with a phone number. The adapter
   * consumes this to emit `<Dial>`. When undefined on a telephony
   * channel, the adapter should fall through to its existing in-app
   * style behavior (audit log only).
   */
  transfer?: TransferDescriptor;
}

/**
 * Build the audit event the in-app and telephony branches both emit
 * when an escalation is requested. Centralizes the metadata so the
 * two paths can never drift in shape.
 */
function buildEscalationAudit(opts: {
  tenantId: string;
  sessionId: string;
  reason: EscalationReason;
  assignedUserId: string | null;
  outcome: 'escalated' | 'no_dispatcher_available' | 'transfer_initiated';
  rotationIndex?: number;
}) {
  return createAuditEvent({
    tenantId: opts.tenantId,
    actorId: opts.sessionId,
    actorRole: 'system',
    eventType: 'escalation.requested',
    entityType: 'session',
    entityId: opts.sessionId,
    correlationId: uuidv4(),
    metadata: {
      reason: opts.reason,
      assignedUserId: opts.assignedUserId,
      outcome: opts.outcome,
      ...(opts.rotationIndex !== undefined ? { rotationIndex: opts.rotationIndex } : {}),
    },
  });
}

export async function escalateToHuman(input: EscalateToHumanInput): Promise<EscalationResult> {
  const {
    tenantId,
    sessionId,
    reason,
    channel,
    onCallRepo,
    auditRepo,
    emergencyDescription,
    callControl,
    dispatcherPhoneResolver,
    callSid,
    dialActionUrl,
    session,
    buildSummary,
    callerContext,
    shopName,
    publicWebBaseUrl,
  } = input;
  const lang: Language = input.language ?? 'en';
  const transferringText = t('escalate.transferring', lang);

  // Telephony branch with `<Dial>` support.
  // ────────────────────────────────────────
  // When the caller wires both `callControl` and a phone resolver and
  // we're on the telephony channel, walk the rotation here so the
  // adapter receives a fully-formed transfer descriptor. We pick the
  // FIRST rotation entry with a non-null phone — the route layer
  // (`/dial-result`) handles the cascade to subsequent entries on
  // no-answer / failed.
  if (
    channel === 'telephony' &&
    dispatcherPhoneResolver
  ) {
    const rotation = await onCallRepo.listRotation(tenantId);

    // Cursor tells us which rotation index to dial next. On the first
    // call we read it (index 0) without advancing; subsequent calls
    // (from /dial-result) pass a higher cursor via callControl.
    // When callControl is not wired (summary-only path), start at 0.
    const cursor = callControl ? callControl.getCursor(sessionId) : { index: 0 };

    // Walk forward from the cursor index, skipping entries with no
    // phone. Stops at the first entry with a phone.
    let chosen: { entry: typeof rotation[number]; phone: string; index: number } | null = null;
    for (let i = cursor.index; i < rotation.length; i++) {
      const entry = rotation[i];
      try {
        const phone = await dispatcherPhoneResolver(tenantId, entry.userId);
        if (phone) {
          chosen = { entry, phone, index: i };
          break;
        }
      } catch (err) {
        // Resolver failed for this user — skip to the next rotation
        // entry rather than aborting the whole escalation. A real
        // operator can drop the broken entry from the rotation; we
        // shouldn't strand the call on a single bad row. Log so the
        // misconfiguration is debuggable; userId is fine to log,
        // phone numbers are not (and we don't have one here anyway).
        // eslint-disable-next-line no-console
        console.warn('[escalate] dispatcherPhoneResolver failed for user', {
          tenantId,
          userId: entry.userId,
          rotationIndex: i,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
    }

    if (!chosen) {
      // Rotation exhausted (or empty). Audit + fall through to the
      // no-dispatcher path so the route can queue the customer
      // callback proposal.
      if (auditRepo) {
        await auditRepo.create(
          buildEscalationAudit({
            tenantId,
            sessionId,
            reason,
            assignedUserId: null,
            outcome: 'no_dispatcher_available',
          }),
        );
      }
      return {
        escalated: false,
        message: "No dispatcher available. We'll follow up shortly.",
      };
    }

    // Stamp the cursor past the just-chosen index so subsequent walks
    // (including /dial-result cascade) resume after it. `advanceCursor`
    // alone only bumps +1 from the stored value, which can stall on the
    // same dispatcher when earlier entries were skipped for missing
    // phones. setCursorAfter is the source of truth here.
    if (callControl) {
      callControl.setCursorAfter(sessionId, chosen.index);
    }

    // Build escalation summary if the caller supplied both a builder
    // callback and caller context. The escalationId is generated here
    // so it can be shared with the whisper cache and SMS deep-link.
    // summary and escalationId are always present together or both absent.
    let summary: EscalationSummary | undefined;
    let escalationId: string | undefined;
    if (buildSummary && callerContext) {
      escalationId = `esc_${uuidv4()}`;
      const ctx: EscalationContext = {
        shopName: shopName ?? 'Our shop',
        caller: callerContext.caller,
        customer: callerContext.customer,
        intent: callerContext.intent,
        reason: mapSkillReasonToBuilderReason(reason),
        transcriptSnapshot: callerContext.transcriptSnapshot,
        ...(publicWebBaseUrl !== undefined ? { publicWebBaseUrl } : {}),
      };
      try {
        summary = buildSummary(ctx);
      } catch (err) {
        // buildSummary threw (e.g. missing template). Log and proceed
        // without a summary — the telephony transfer still succeeds;
        // only the dispatcher context is degraded.
        // eslint-disable-next-line no-console
        console.warn('[escalate] buildSummary threw — proceeding without summary', {
          tenantId,
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
        // Reset escalationId too since we have no summary to pair it with.
        escalationId = undefined;
      }
    }

    // Build the dial TwiML. Action URL is required so Twilio POSTs the
    // outcome to /dial-result. Caller passes it via `dialActionUrl`;
    // when missing we still produce a transfer descriptor with a
    // best-effort placeholder so the adapter can recover.
    // When callControl is not wired (summary-only path), fallbackTwiml is
    // undefined — adapters must guard on this and not send an empty string
    // to Twilio (which would return HTTP 400).
    const channelPrefs = input.channelPreferences ?? {
      sms: true,
      in_app: true,
      whisper: true,
    };
    const baseUrl = publicWebBaseUrl?.replace(/\/$/, '');
    const whisperUrl =
      escalationId &&
      summary &&
      channelPrefs.whisper &&
      baseUrl
        ? `${baseUrl}/api/telephony/whisper/${escalationId}`
        : undefined;

    const fallbackTwiml: string | undefined = callControl
      ? callControl.dialDispatcher(
          callSid ?? sessionId,
          chosen.phone,
          {
            actionUrl: dialActionUrl ?? `/api/telephony/dial-result?sid=${encodeURIComponent(sessionId)}`,
            ...(whisperUrl ? { whisperUrl } : {}),
          },
        )
      : undefined;

    if (auditRepo) {
      await auditRepo.create(
        buildEscalationAudit({
          tenantId,
          sessionId,
          reason,
          assignedUserId: chosen.entry.userId,
          outcome: 'transfer_initiated',
          rotationIndex: chosen.index,
        }),
      );
    }

    let message = transferringText;
    if (reason === 'emergency_dispatch') {
      const desc = emergencyDescription ? ` regarding: ${emergencyDescription}` : '';
      message =
        lang === 'es'
          ? `Escalamiento de emergencia en curso${desc}. Le voy a conectar con un despachador de inmediato.`
          : `Emergency escalation in progress${desc}. Connecting you with a dispatcher immediately.`;
    }

    if (session) {
      session.events.emit(VOICE_EVENT_CHANNEL, escalationTriggeredEvent(reason));
    }

    return {
      escalated: true,
      assignedUserId: chosen.entry.userId,
      message,
      transfer: {
        dispatcherPhone: chosen.phone,
        fallbackTwiml,
        rotationEntryId: chosen.entry.id,
        dispatcherUserId: chosen.entry.userId,
        rotationIndex: chosen.index,
        summary,
        escalationId,
        channelPreferences: channelPrefs,
      },
    };
  }

  // Default branch (in-app, or telephony without dispatcherPhoneResolver).
  // ─────────────────────────────────────────────────────────────────
  // Look up next on-call dispatcher
  const entry = await onCallRepo.getNextOnCall(tenantId);

  if (!entry) {
    // Emit audit event even when no dispatcher is available
    if (auditRepo) {
      await auditRepo.create(
        buildEscalationAudit({
          tenantId,
          sessionId,
          reason,
          assignedUserId: null,
          outcome: 'no_dispatcher_available',
        }),
      );
    }

    return {
      escalated: false,
      message: "No dispatcher available. We'll follow up shortly.",
    };
  }

  // Emit audit event for successful escalation
  if (auditRepo) {
    await auditRepo.create(
      buildEscalationAudit({
        tenantId,
        sessionId,
        reason,
        assignedUserId: entry.userId,
        outcome: 'escalated',
      }),
    );
  }

  // Build the result message
  let message = transferringText;
  if (reason === 'emergency_dispatch') {
    const desc = emergencyDescription
      ? ` regarding: ${emergencyDescription}`
      : '';
    message =
      lang === 'es'
        ? `Escalamiento de emergencia en curso${desc}. Le voy a conectar con un despachador de inmediato.`
        : `Emergency escalation in progress${desc}. Connecting you with a dispatcher immediately.`;
  }

  const result: EscalationResult = {
    escalated: true,
    assignedUserId: entry.userId,
    message,
  };

  if (session) {
    session.events.emit(VOICE_EVENT_CHANNEL, escalationTriggeredEvent(reason));
  }

  return result;
}
