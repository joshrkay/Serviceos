/**
 * P8-016 — owner-cell patch orchestrator.
 *
 * Terminal action for a `patch_owner` triage decision (vulnerability AND
 * urgency). It pages the TENANT OWNER's cell directly — a SEPARATE path from
 * the dispatcher rotation — and plays a deterministic 5-second context preface
 * before connecting the caller.
 *
 * Flow:
 *   1. Resolve the owner's cell via the injected `ownerPhoneResolver`.
 *      - null → skip straight to the unreachable FALLBACK (no number to dial).
 *   2. `<Dial>` the owner with a 60-second timeout and the preface as the
 *      whisper played in the owner's ear before bridging.
 *   3. If the owner answers, the call is bridged (handled by the telephony
 *      adapter / dial-result route — out of scope here).
 *   4. If the owner is UNREACHABLE for 60s (no-answer / busy / voicemail / no
 *      number), FALL BACK to:
 *        (a) create a high-priority booking proposal carrying the
 *            vulnerability-signal metadata in its sourceContext, AND
 *        (b) SMS the owner what happened.
 *
 * NO MEDICAL AUTHORITY: the preface (and the SMS) use only the NON-PII evidence
 * strings; they never assert a clinical claim. The owner is never auto-booked
 * into the normal flow — the booking is explicitly high-priority + owner-
 * notified.
 *
 * This module performs no real I/O itself; every effect (dialing, proposal
 * creation, SMS) is an INJECTED seam so it is fully unit-testable without a
 * live telephony provider, DB, or network.
 */
import type {
  TriageDecision,
  VulnerabilitySignal,
} from '@ai-service-os/shared';
import type { TwilioCallControl } from '../../telephony/twilio-call-control';
import type { OwnerPhoneResolver } from '../../ai/skills/escalate-to-human';
import {
  composeContextPreface,
  type PrefaceCustomer,
} from './context-preface';

/** Twilio `<Dial>` no-answer timeout for the owner cell, per the story. */
export const OWNER_DIAL_TIMEOUT_SECONDS = 60;

/** Why the patch fell back to a high-priority booking instead of bridging. */
export type OwnerPatchFallbackReason =
  | 'no_owner_number'
  | 'owner_unreachable';

export interface OwnerPatchDeps {
  /** Resolves the tenant owner's E.164 cell, or null when none on file. */
  ownerPhoneResolver: OwnerPhoneResolver;
  /** Telephony call control used to build the `<Dial>` whisper TwiML. */
  callControl: TwilioCallControl;
  /**
   * Create the high-priority booking proposal carrying the vulnerability
   * signal metadata. Injected so this module stays decoupled from the (Tier-1
   * locked) proposal-contracts surface. Returns the new proposal id.
   */
  createHighPriorityBooking: (input: {
    tenantId: string;
    voiceSessionId: string;
    customerId: string | null;
    sourceContext: {
      reason: 'vulnerability_patch_fallback';
      fallbackReason: OwnerPatchFallbackReason;
      decisionKind: TriageDecision['kind'];
      urgency: TriageDecision['urgency'];
      scoreTotal: number;
      weatherUnavailable: boolean;
      signals: VulnerabilitySignal[];
    };
  }) => Promise<{ proposalId: string }>;
  /** SMS the owner what happened on the unreachable fallback. */
  sendSms: (input: { to: string; body: string }) => Promise<unknown>;
}

export interface OwnerPatchInput {
  tenantId: string;
  voiceSessionId: string;
  /** Active Twilio call leg sid (falls back to voiceSessionId if absent). */
  callSid?: string;
  /** Absolute URL Twilio POSTs once the owner `<Dial>` completes. */
  dialActionUrl: string;
  /** The triage decision (MUST be `patch_owner`). */
  decision: TriageDecision;
  /** Matched customer (null for unknown callers). */
  customerId: string | null;
  /** NON-PII customer label inputs for the preface. */
  prefaceCustomer?: PrefaceCustomer;
}

export type OwnerPatchResult =
  | {
      kind: 'patched';
      /** E.164 owner cell that was dialed. Treat as PII — never log raw. */
      ownerPhone: string;
      /** Complete `<Dial>` TwiML the adapter hands back to Twilio. */
      twiml: string;
      /** The deterministic preface spoken to the owner before bridging. */
      preface: string;
    }
  | {
      kind: 'fallback';
      fallbackReason: OwnerPatchFallbackReason;
      proposalId: string;
      /** True when the owner SMS was sent (false when no owner number). */
      ownerNotified: boolean;
    };

/**
 * Compose the owner-notification SMS for the unreachable fallback. NON-PII:
 * vulnerability labels + non-clinical evidence + the booking note. No address,
 * no diagnosis.
 */
export function composeOwnerFallbackSms(decision: TriageDecision): string {
  const evidence = decision.score.signals
    .map((s) => s.evidence)
    .join('; ');
  return (
    `Priority call you missed: ${decision.reason}. ` +
    `${evidence ? `Signals: ${evidence}. ` : ''}` +
    `Logged a high-priority booking for your review.`
  );
}

async function runFallback(
  input: OwnerPatchInput,
  deps: OwnerPatchDeps,
  fallbackReason: OwnerPatchFallbackReason,
  ownerPhone: string | null,
): Promise<OwnerPatchResult> {
  const { proposalId } = await deps.createHighPriorityBooking({
    tenantId: input.tenantId,
    voiceSessionId: input.voiceSessionId,
    customerId: input.customerId,
    sourceContext: {
      reason: 'vulnerability_patch_fallback',
      fallbackReason,
      decisionKind: input.decision.kind,
      urgency: input.decision.urgency,
      scoreTotal: input.decision.score.total,
      weatherUnavailable: input.decision.score.weatherUnavailable,
      signals: input.decision.score.signals,
    },
  });

  let ownerNotified = false;
  if (ownerPhone) {
    await deps.sendSms({
      to: ownerPhone,
      body: composeOwnerFallbackSms(input.decision),
    });
    ownerNotified = true;
  }

  return { kind: 'fallback', fallbackReason, proposalId, ownerNotified };
}

/**
 * Build the owner `<Dial>` (whisper = the preface) OR fall back when no owner
 * number is on file. The 60s no-answer outcome is driven by Twilio's dial
 * timeout: when the dial-result route reports no-answer/busy/failed it calls
 * `handleOwnerDialResult` below to run the same fallback.
 */
export async function patchToOwnerCell(
  input: OwnerPatchInput,
  deps: OwnerPatchDeps,
): Promise<OwnerPatchResult> {
  if (input.decision.kind !== 'patch_owner') {
    throw new Error(
      `patchToOwnerCell requires a patch_owner decision, got ${input.decision.kind}`,
    );
  }

  const ownerPhone = await deps.ownerPhoneResolver(input.tenantId);
  if (!ownerPhone) {
    // No number to dial → straight to fallback. SMS cannot be sent (no
    // number), but the high-priority booking is still created so the call is
    // never silently dropped.
    return runFallback(input, deps, 'no_owner_number', null);
  }

  const preface = composeContextPreface({
    signals: input.decision.score.signals,
    reason: input.decision.reason,
    customer: input.prefaceCustomer,
  });

  // The preface is delivered as the whisper played in the owner's ear before
  // bridging. The whisper URL is built by the adapter from the preface; here
  // we surface both the TwiML and the preface so the adapter can wire the
  // whisper playback. timeoutSeconds = 60 enforces the no-answer budget.
  const twiml = deps.callControl.dialDispatcher(
    input.callSid ?? input.voiceSessionId,
    ownerPhone,
    {
      actionUrl: input.dialActionUrl,
      timeoutSeconds: OWNER_DIAL_TIMEOUT_SECONDS,
    },
  );

  return { kind: 'patched', ownerPhone, twiml, preface };
}

/** Twilio dial-result statuses that mean the owner did not pick up. */
const UNREACHABLE_DIAL_STATUSES: ReadonlySet<string> = new Set([
  'no-answer',
  'busy',
  'failed',
  'canceled',
  // voicemail is reported by some configs as 'completed' with a short
  // duration; the route maps that to this set before calling us.
  'voicemail',
]);

/**
 * Called by the dial-result route when the owner `<Dial>` finished. On any
 * unreachable status (the 60s no-answer case included) run the fallback:
 * high-priority booking + owner SMS. On 'answered'/'completed' (bridged) this
 * returns null — nothing more to do.
 */
export async function handleOwnerDialResult(
  input: OwnerPatchInput,
  deps: OwnerPatchDeps,
  dialStatus: string,
  ownerPhone: string,
): Promise<OwnerPatchResult | null> {
  if (!UNREACHABLE_DIAL_STATUSES.has(dialStatus)) return null;
  return runFallback(input, deps, 'owner_unreachable', ownerPhone);
}

export { UNREACHABLE_DIAL_STATUSES };
