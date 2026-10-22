/**
 * #1738 — the instant first-response text for leads that arrive through the
 * public intake form and the customer portal (LSA leads have their own gate in
 * `lsa/lsa-webhook.ts`).
 *
 * Gates, in order — each skip is a recorded outcome, never a guess:
 *  1. the owner turned on "text new leads right away" (`speed_to_lead_enabled`,
 *     off by default);
 *  2. the submission created a NEW lead (a repeat submission attached to an
 *     open lead is not new work and must not re-text);
 *  3. the person agreed to texts: the form's unticked consent box, or a portal
 *     customer's stored SMS consent (owner decision 2026-10-22);
 *  4. SMS delivery is configured;
 *  5. then `sendSpeedToLeadResponse` (eligible source, has a phone) and the
 *     DNC-gated reply path.
 *
 * Best-effort: never throws, so lead capture is never disturbed. Not silent:
 * once the owner has the feature on, every outcome is audited on the lead
 * (`lead.speed_to_lead`), and a text that should have gone out but could not
 * pushes the owner to call the lead instead (or, when the send could not be
 * confirmed either way, to check the lead's messages before calling).
 */
import { createAuditEventBestEffort, type AuditRepository } from '../audit/audit';
import { ConversationReplyError } from '../conversations/reply-service';
import { notifyOwner } from '../notifications/owner-notifications-instance';
import type { SettingsRepository } from '../settings/settings';
import type { Lead } from './lead';
import type { LeadCaptureOutcome } from './lead-service';
import { sendSpeedToLeadResponse, type SpeedToLeadSender } from './speed-to-lead';

export const NEW_LEAD_AUTO_REPLY_ACTOR_ID = 'system:speed-to-lead';

/** The sender could not confirm whether the text went out (see LeadTextUnconfirmedError). */
const UNCONFIRMED = 'send_failed:unconfirmed';

/** Outcomes that mean the lead was owed a text and may not have got one. */
const OWNER_SHOULD_FOLLOW_UP = (reason: string): boolean =>
  reason === 'unavailable' ||
  (reason.startsWith('send_failed:') && reason !== 'send_failed:dnc_blocked');

export interface NewLeadAutoReplyDeps {
  settingsRepo: Pick<SettingsRepository, 'findByTenant'>;
  auditRepo: AuditRepository;
  /** Absent when SMS delivery is not configured in this environment. */
  send?: SpeedToLeadSender;
}

export interface NewLeadAutoReplyInput {
  lead: Lead;
  outcome: LeadCaptureOutcome;
  /** The visitor ticked the consent box, or the portal customer has stored SMS consent. */
  smsConsent: boolean;
}

export type NewLeadAutoReply = (input: NewLeadAutoReplyInput) => Promise<string>;

export function createNewLeadAutoReply(deps: NewLeadAutoReplyDeps): NewLeadAutoReply {
  // Reply-path refusals carry a stable code; record the code, not prose.
  const send: SpeedToLeadSender | undefined = deps.send
    ? async (args) => {
        try {
          await deps.send!(args);
        } catch (err) {
          if (err instanceof ConversationReplyError) throw new Error(err.code);
          throw err;
        }
      }
    : undefined;

  return async ({ lead, outcome, smsConsent }) => {
    let settings;
    try {
      settings = await deps.settingsRepo.findByTenant(lead.tenantId);
    } catch {
      // Without settings we cannot know the owner opted in: do not text.
      return 'settings_unavailable';
    }
    if (!settings?.speedToLeadEnabled) return 'disabled';

    let reason: string;
    if (outcome !== 'created') reason = 'existing_lead';
    else if (!smsConsent) reason = 'no_sms_consent';
    else if (!send) reason = 'unavailable';
    else {
      reason = (
        await sendSpeedToLeadResponse(
          { send },
          {
            lead,
            businessName: settings.businessName ?? '',
            settings: { speedToLeadEnabled: true, speedToLeadTemplate: settings.speedToLeadTemplate },
          },
        )
      ).reason;
    }

    await createAuditEventBestEffort(deps.auditRepo, {
      tenantId: lead.tenantId,
      actorId: NEW_LEAD_AUTO_REPLY_ACTOR_ID,
      actorRole: 'system',
      eventType: 'lead.speed_to_lead',
      entityType: 'lead',
      entityId: lead.id,
      metadata: { source: lead.source, sent: reason === 'sent', outcome: reason },
    });

    if (OWNER_SHOULD_FOLLOW_UP(reason)) {
      const who = [lead.firstName, lead.lastName].filter(Boolean).join(' ').trim() || 'A new lead';
      // 'unconfirmed': the text may have gone out but wasn't recorded, so a
      // blind "call them" could double-contact the lead.
      const message =
        reason === UNCONFIRMED
          ? `${who} asked for a text back. The automatic reply may have gone out, but it couldn't be confirmed. Check their messages before you call.`
          : `${who} asked for a text back, but the automatic reply didn't go out. Give them a call.`;
      try {
        await notifyOwner(lead.tenantId, 'escalation', { reason: message });
      } catch {
        // The audit row above still records the miss.
      }
    }
    return reason;
  };
}
