/**
 * Email transports. Two implementations:
 *  - ResendTransport: real HTTP POST to api.resend.com/emails, used when
 *    RESEND_API_KEY is configured.
 *  - PreviewTransport: default when no key is set. Writes to the in-memory
 *    mailbox (mailbox.ts) plus a structured console log, so the send path is
 *    fully exercisable in local/demo/CI without any external dependency.
 *
 * IMPORTANT: transports are the delivery mechanism ONLY. The test-contacts
 * allowlist gate (allowlist.ts) is enforced in the SEND path in engine.ts,
 * before a transport is ever selected or called — a transport must never be
 * relied on to perform that check.
 */
import { pushToMailbox } from './mailbox';

/** Default "from" address. Configurable via NURTURE_FROM_ADDRESS for
 * environments that need a different sender identity. */
export const DEFAULT_FROM_ADDRESS =
  process.env.NURTURE_FROM_ADDRESS || 'Josh at Rivet <josh@updates.rivet.example>';

export interface SendEmailInput {
  to: string;
  from: string;
  subject: string;
  bodyHtml: string;
  bodyText: string;
  /** Metadata for logging/mailbox display; not sent to the ESP. */
  emailId: string;
  previewText: string;
}

export interface SendEmailResult {
  ok: boolean;
  id?: string;
  error?: string;
}

export interface EmailTransport {
  name: 'resend' | 'preview';
  send(input: SendEmailInput): Promise<SendEmailResult>;
}

/**
 * ResendTransport — real HTTP POST to api.resend.com/emails using
 * RESEND_API_KEY. Request shape per Resend's send-email API:
 * https://resend.com/docs/api-reference/emails/send-email
 */
export const resendTransport: EmailTransport = {
  name: 'resend',
  async send(input) {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      return { ok: false, error: 'RESEND_API_KEY is not configured' };
    }

    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: input.from,
          to: [input.to],
          subject: input.subject,
          html: input.bodyHtml,
          text: input.bodyText,
        }),
      });

      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        return { ok: false, error: `Resend send failed (${res.status}): ${detail}` };
      }

      const json = (await res.json().catch(() => ({}))) as { id?: string };

      // Mirror into the in-memory mailbox too, purely for demo/preview
      // visibility (the real delivery already happened via the API call above).
      pushToMailbox({
        to: input.to,
        from: input.from,
        emailId: input.emailId,
        subject: input.subject,
        previewText: input.previewText,
        bodyHtml: input.bodyHtml,
        bodyText: input.bodyText,
        transport: 'resend',
      });

      return { ok: true, id: json.id };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'unknown error' };
    }
  },
};

/**
 * PreviewTransport — default when no RESEND_API_KEY is set. Stores the send
 * in the in-memory mailbox and logs a structured line so the send is
 * observable without any external service.
 */
export const previewTransport: EmailTransport = {
  name: 'preview',
  async send(input) {
    const entry = pushToMailbox({
      to: input.to,
      from: input.from,
      emailId: input.emailId,
      subject: input.subject,
      previewText: input.previewText,
      bodyHtml: input.bodyHtml,
      bodyText: input.bodyText,
      transport: 'preview',
    });

    console.log(
      JSON.stringify({
        at: entry.at,
        source: 'nurture.preview-transport',
        to: input.to,
        emailId: input.emailId,
        subject: input.subject,
      }),
    );

    return { ok: true, id: entry.id };
  },
};

/** Transport selection: RESEND_API_KEY present -> Resend, else preview. */
export function selectTransport(): EmailTransport {
  return process.env.RESEND_API_KEY ? resendTransport : previewTransport;
}
