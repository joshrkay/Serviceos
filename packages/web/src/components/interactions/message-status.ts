/**
 * D-045 — plain words for one message record (`message_dispatches` row):
 * what happened to it and, when it did not go out, why. Shared by the status
 * bubble on job and customer pages and by the dispatch log.
 */

import { formatDateTimeInTenantTz } from '../../utils/formatInTenantTz';

export interface MessageDispatch {
  id: string;
  entityType: string;
  entityId: string;
  channel: 'sms' | 'email';
  recipient: string;
  provider: string;
  providerMessageId?: string;
  status: string;
  errorMessage?: string;
  sentAt: string;
  deliveredAt?: string;
  customerId?: string;
  jobId?: string;
  purpose?: string;
  scheduledFor?: string;
  blockReason?: string;
  blockPermanent?: boolean;
}

export type MessageTone = 'ok' | 'pending' | 'problem';

/** Why outbound messaging did not send a text (api: MessageBlockReason). */
const BLOCK_REASON_LABEL: Record<string, string> = {
  no_consent: 'the customer has not agreed to texts',
  revoked: 'the customer opted out of texts',
  dnc: 'the number is on the do-not-contact list',
  missing_consent_context: 'consent could not be checked',
  channel_disabled: 'texting is switched off',
  recipient_volume_cap: 'this number already got the most texts allowed today',
  customer_not_found: 'the customer record was not found',
  no_phone: 'there is no phone number on file',
  no_marketing_consent: 'the customer has not agreed to marketing texts',
  send_failed: 'the text provider refused it',
  lookup_failed: "the customer's texting details couldn't be checked",
};

export function blockReasonLabel(reason: string | undefined): string {
  if (!reason) return 'no reason was recorded';
  return BLOCK_REASON_LABEL[reason] ?? reason.replace(/_/g, ' ');
}

export interface MessageSummary {
  /** One line, e.g. "Text sent" or "Text not sent: the customer opted out of texts". */
  headline: string;
  tone: MessageTone;
  /** When it happened (or, when held, when it will go out), in the tenant's timezone. */
  when: string;
}

export function summarizeMessage(d: MessageDispatch, timezone: string): MessageSummary {
  const noun = d.channel === 'email' ? 'Email' : 'Text';
  const at = (iso: string) => formatDateTimeInTenantTz(iso, timezone);
  switch (d.status) {
    case 'sent':
      return { headline: `${noun} sent`, tone: 'ok', when: at(d.sentAt) };
    case 'delivered':
      return { headline: `${noun} delivered`, tone: 'ok', when: at(d.deliveredAt ?? d.sentAt) };
    case 'scheduled':
      return {
        headline: `${noun} held until morning`,
        tone: 'pending',
        when: d.scheduledFor ? `Goes out ${at(d.scheduledFor)}` : at(d.sentAt),
      };
    case 'blocked':
      return {
        headline: `${noun} not sent: ${blockReasonLabel(d.blockReason)}`,
        tone: 'problem',
        when: at(d.sentAt),
      };
    case 'failed':
      return { headline: `${noun} failed`, tone: 'problem', when: at(d.sentAt) };
    case 'bounced':
      return { headline: `${noun} bounced`, tone: 'problem', when: at(d.sentAt) };
    default:
      return { headline: `${noun} ${d.status}`, tone: 'pending', when: at(d.sentAt) };
  }
}

export const TONE_CLASSES: Record<MessageTone, string> = {
  ok: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  pending: 'border-amber-200 bg-amber-50 text-amber-800',
  problem: 'border-red-200 bg-red-50 text-red-800',
};
