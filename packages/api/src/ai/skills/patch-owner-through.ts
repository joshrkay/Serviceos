/**
 * RV-121 — patch-owner-through skill.
 *
 * Terminal action for a vulnerable + urgent caller (triage `patch_owner`):
 * announce to the caller, then bridge them STRAIGHT to the owner's cell via
 * the Twilio call-control transfer surface (`dialDispatcher` — the same
 * `<Dial>` seam every other transfer uses; there is no separate conference
 * primitive in TwilioCallControl).
 *
 * Fallback ladder (each rung only when the previous is unavailable):
 *   1. OWNER  — tenant owner's cell (ownerPhoneResolver).
 *   2. ON-CALL — first dispatcher in the rotation with a resolvable phone.
 *   3. VOICEMAIL + urgent owner SMS + call_me_back task ('urgent' semantics:
 *      reason 'vulnerability_patch', scheduledFor now) — the caller leaves a
 *      message instead of being stranded, the owner is paged about the miss,
 *      and the durable CSR queue keeps surfacing the callback.
 *
 * Pure orchestration: every effect (dial TwiML, SMS, task row, audit) is an
 * injected seam — fully unit-testable with mocks, no Twilio SDK.
 */
import type { TwilioCallControl } from '../../telephony/twilio-call-control';
import { buildVoicemailTwiml } from '../../telephony/voicemail-fallback';
import type { OnCallRepository } from '../../oncall/rotation';
import type { CallMeBackRepository } from '../../voice/call-me-back/call-me-back';
import { AuditRepository, createAuditEvent } from '../../audit/audit';
import type {
  DispatcherPhoneResolver,
  OwnerPhoneResolver,
} from './escalate-to-human';

/** Dial timeout for the owner/on-call rung (shorter than the P8-016 60s — a vulnerable caller should not sit in dead air). */
export const PATCH_DIAL_TIMEOUT_SECONDS = 25;

export interface PatchOwnerThroughDeps {
  callControl: TwilioCallControl;
  ownerPhoneResolver: OwnerPhoneResolver;
  /** Rung 2 — on-call rotation. Both optional; absent skips the rung. */
  onCallRepo?: OnCallRepository;
  dispatcherPhoneResolver?: DispatcherPhoneResolver;
  /** Rung 3 — urgent owner/on-call SMS page. */
  sendSms?: (args: { to: string; body: string }) => Promise<unknown>;
  /** Rung 3 — durable urgent callback task. */
  callMeBackRepo?: CallMeBackRepository;
  auditRepo?: AuditRepository;
}

export interface PatchOwnerThroughInput {
  tenantId: string;
  sessionId: string;
  /** Active Twilio call leg (falls back to sessionId for tests). */
  callSid?: string;
  /** Absolute URL Twilio POSTs once the `<Dial>` completes. */
  dialActionUrl: string;
  /** NON-PII reason line (from the triage decision) used in the SMS page. */
  reason: string;
  /** Caller E.164 for the callback task / page. */
  callerPhone?: string;
  shopName: string;
  /** Voicemail recording webhook (rung 3). Required to emit voicemail TwiML. */
  voicemailRecordingCallbackUrl?: string;
}

/**
 * Spoken to the caller before the bridge (prepended as <Say>). Per-rung
 * copy: the on-call rung must not promise "the owner" — a vulnerable caller
 * told they're being connected to the owner and answered by a dispatcher
 * starts the human handoff with a broken promise.
 */
export const PATCH_ANNOUNCE_LINE_OWNER =
  "I'm going to patch you straight through to the owner — stay on the line with me.";
export const PATCH_ANNOUNCE_LINE_ONCALL =
  "I'm going to patch you straight through to our team — stay on the line with me.";

export type PatchOwnerThroughResult =
  | {
      kind: 'bridged';
      target: 'owner' | 'oncall';
      /** E.164 dialed. PII — never log raw. */
      phone: string;
      /** Complete <Response> with the announce <Say> + <Dial>. */
      twiml: string;
    }
  | {
      kind: 'fallback';
      /** Voicemail TwiML when a recording callback was supplied. */
      voicemailTwiml?: string;
      smsSent: boolean;
      callMeBackTaskId?: string;
    };

function withAnnounce(twiml: string, announce: string): string {
  const safe = announce
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
  return twiml.replace('<Response>', `<Response><Say voice="Polly.Joanna">${safe}</Say>`);
}

export function composePatchMissSms(input: PatchOwnerThroughInput): string {
  const caller = input.callerPhone ? ` Caller: ${input.callerPhone}.` : '';
  const body =
    `${input.shopName} URGENT: vulnerable caller could not be patched through — ${input.reason}.` +
    `${caller} They were sent to voicemail; a callback task is queued.`;
  return body.length > 320 ? `${body.slice(0, 317)}…` : body;
}

export async function patchOwnerThrough(
  input: PatchOwnerThroughInput,
  deps: PatchOwnerThroughDeps,
): Promise<PatchOwnerThroughResult> {
  const callSid = input.callSid ?? input.sessionId;

  const audit = async (outcome: string, metadata: Record<string, unknown>) => {
    if (!deps.auditRepo) return;
    try {
      await deps.auditRepo.create(
        createAuditEvent({
          tenantId: input.tenantId,
          actorId: input.sessionId,
          actorRole: 'system',
          eventType: 'vulnerability_patch.attempted',
          entityType: 'voice_session',
          entityId: input.sessionId,
          correlationId: input.sessionId,
          metadata: { outcome, reason: input.reason, ...metadata },
        }),
      );
    } catch {
      /* audit is best-effort */
    }
  };

  // Rung 1 — owner cell.
  let ownerPhone: string | null = null;
  try {
    ownerPhone = await deps.ownerPhoneResolver(input.tenantId);
  } catch {
    ownerPhone = null;
  }
  if (ownerPhone) {
    const twiml = withAnnounce(
      deps.callControl.dialDispatcher(callSid, ownerPhone, {
        actionUrl: input.dialActionUrl,
        timeoutSeconds: PATCH_DIAL_TIMEOUT_SECONDS,
      }),
      PATCH_ANNOUNCE_LINE_OWNER,
    );
    await audit('bridged_owner', {});
    return { kind: 'bridged', target: 'owner', phone: ownerPhone, twiml };
  }

  // Rung 2 — on-call rotation (first resolvable phone).
  if (deps.onCallRepo && deps.dispatcherPhoneResolver) {
    try {
      const rotation = await deps.onCallRepo.listRotation(input.tenantId);
      for (const entry of rotation) {
        let phone: string | null = null;
        try {
          phone = await deps.dispatcherPhoneResolver(input.tenantId, entry.userId);
        } catch {
          continue;
        }
        if (phone) {
          const twiml = withAnnounce(
            deps.callControl.dialDispatcher(callSid, phone, {
              actionUrl: input.dialActionUrl,
              timeoutSeconds: PATCH_DIAL_TIMEOUT_SECONDS,
            }),
            PATCH_ANNOUNCE_LINE_ONCALL,
          );
          await audit('bridged_oncall', { dispatcherUserId: entry.userId });
          return { kind: 'bridged', target: 'oncall', phone, twiml };
        }
      }
    } catch {
      /* rotation lookup failure falls through to rung 3 */
    }
  }

  // Rung 3 — voicemail + urgent SMS + call_me_back(urgent).
  let smsSent = false;
  if (deps.sendSms) {
    // Page whatever line exists, even though the patch couldn't bridge —
    // owner resolution failed above, so this targets the rotation's first
    // phone or is skipped entirely when nothing is resolvable.
    let pageTo: string | null = null;
    if (deps.onCallRepo && deps.dispatcherPhoneResolver) {
      try {
        const rotation = await deps.onCallRepo.listRotation(input.tenantId);
        for (const entry of rotation) {
          pageTo = await deps.dispatcherPhoneResolver(input.tenantId, entry.userId).catch(() => null);
          if (pageTo) break;
        }
      } catch {
        pageTo = null;
      }
    }
    if (pageTo) {
      try {
        await deps.sendSms({ to: pageTo, body: composePatchMissSms(input) });
        smsSent = true;
      } catch {
        smsSent = false;
      }
    }
  }

  let callMeBackTaskId: string | undefined;
  if (deps.callMeBackRepo && input.callerPhone) {
    try {
      const task = await deps.callMeBackRepo.create({
        tenantId: input.tenantId,
        sessionId: input.sessionId,
        ...(input.callSid ? { callSid: input.callSid } : {}),
        callerPhone: input.callerPhone,
        callbackMessage: `URGENT vulnerable caller: ${input.reason}`,
        intentSummary: 'vulnerability_patch',
        reason: 'vulnerability_patch',
        scheduledFor: new Date(),
      });
      callMeBackTaskId = task.id;
    } catch {
      /* the voicemail still answers the caller; the task is best-effort */
    }
  }

  const voicemailTwiml = input.voicemailRecordingCallbackUrl
    ? buildVoicemailTwiml({
        shopName: input.shopName,
        recordingStatusCallback: input.voicemailRecordingCallbackUrl,
      })
    : undefined;

  await audit('fallback_voicemail', { smsSent, callMeBackTaskId: callMeBackTaskId ?? null });
  return {
    kind: 'fallback',
    ...(voicemailTwiml ? { voicemailTwiml } : {}),
    smsSent,
    ...(callMeBackTaskId ? { callMeBackTaskId } : {}),
  };
}
