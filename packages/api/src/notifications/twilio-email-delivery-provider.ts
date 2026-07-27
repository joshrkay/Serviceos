import {
  DeliveryResult,
  EmailMessage,
  MessageDeliveryProvider,
} from './delivery-provider';
import { DeliveryError } from './notification-errors';

/**
 * Production email delivery via Twilio's NATIVE Email API.
 *
 *   POST https://comms.twilio.com/v1/Emails
 *
 * This is a DIFFERENT product from SendGrid. Same vendor, different API,
 * different credentials, different payload, different templating language:
 *
 *   | | Twilio Email (this file)        | SendGrid (twilio-delivery-provider) |
 *   |-|---------------------------------|-------------------------------------|
 *   | URL   | comms.twilio.com/v1/Emails | api.sendgrid.com/v3/mail/send       |
 *   | Auth  | HTTP Basic, Account SID +  | Bearer SENDGRID_API_KEY             |
 *   |       | Auth Token (SMS creds)     | (`SG.`-prefixed)                    |
 *   | Body  | from/to/content            | personalizations/content            |
 *   | Templating | Liquid `{{var}}`      | Handlebars `{{var}}`                |
 *
 * Why this exists: production has TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN /
 * TWILIO_FROM_NUMBER but NO SendGrid credentials, and the operator's email
 * goes through Twilio. The SendGrid leg therefore can never authenticate.
 * This provider reuses the SMS credentials verbatim — no new secret.
 *
 * ASYNCHRONOUS BY DESIGN. A 202 means "queued", NOT "delivered". The response
 * carries `operationId` (used as our providerMessageId) and
 * `operationLocation` (`.../v1/Emails/Operations/<operationId>`), which is the
 * handle for true delivery status. We deliberately treat 202 as success-queued
 * — exactly how the SendGrid leg treats its own 202 + `x-message-id` — so this
 * fits the existing MessageDeliveryProvider contract unchanged.
 *
 * FOLLOW-UP (not in this change): poll `operationLocation` to resolve queued →
 * delivered/bounced and reconcile message_dispatches.status. Nothing is lost by
 * not storing the URL: it is derivable from apiBaseUrl + operationId.
 *
 * NOT SUPPORTED by the Twilio Email API and therefore intentionally dropped:
 *   - `replyTo`  — no reply-to field is documented. No product call site sets
 *                  EmailMessage.replyTo today (only the SendGrid config-level
 *                  SENDGRID_REPLY_TO_EMAIL does).
 *   - `tenantId` — SendGrid's `custom_args` has no documented equivalent
 *                  (Twilio Email has "tags", but the request schema for them
 *                  is undocumented; guessing it risks a 400 on every send).
 *   - `idempotencyKey` — no documented idempotency header.
 * Each is a silent no-op rather than a throw, because failing a real customer
 * send over an unsupported observability field would be worse than losing the
 * field. Revisit when Twilio documents tags/reply-to.
 */

export interface TwilioEmailConfig {
  /** Twilio Account SID — the SAME one used for SMS. */
  accountSid: string;
  /** Twilio Auth Token (or an API Key Secret) — the SAME one used for SMS. */
  authToken: string;
  /**
   * Sender address. MUST belong to an APPROVED Verified Sender domain in the
   * Twilio console, or every send 400s/401s regardless of code correctness.
   */
  fromAddress: string;
  /** Display name shown alongside fromAddress. */
  fromName?: string;
  /** Override for tests. Defaults to Twilio's Email API host. */
  apiBaseUrl?: string;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

/** 202 Accepted body. Both fields are documented; treat both as optional. */
interface TwilioEmailAcceptedResponse {
  operationId?: string;
  operationLocation?: string;
}

interface NormalizedProviderFailure {
  code: 'AUTH_FAILED' | 'PROVIDER_FAILED';
  message: string;
  status?: number;
  providerBody?: string;
  providerCode?: string;
  retriable: boolean;
  retryAfterSeconds?: number;
  providerRequestId?: string;
}

function parseRetryAfterSeconds(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const seconds = Number.parseInt(value, 10);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

/**
 * Parallel of `classifySendgridError` in twilio-delivery-provider.ts — same
 * error taxonomy (AUTH_FAILED / PROVIDER_FAILED + retriable), Twilio's headers
 * and status codes:
 *
 *   202 accepted · 400 bad request (validation; returns as many issues as it
 *   can in one body) · 401 unauthorized · 429 rate limited (back off) ·
 *   500 / 503 transient (retry with backoff).
 *
 * 400 and 401 are the two an operator will actually hit in production, and the
 * overwhelmingly likely cause is a missing/unapproved Verified Sender for the
 * `from` domain — not a code bug. The messages say so, so the log line is
 * self-diagnosing.
 */
export function classifyTwilioEmailError(
  response: Response,
  providerBody: string
): NormalizedProviderFailure {
  const providerCode = response.headers.get('twilio-error-code') ?? undefined;
  const requestId =
    response.headers.get('twilio-request-id') ?? response.headers.get('x-request-id') ?? undefined;
  const retryAfterSeconds = parseRetryAfterSeconds(response.headers.get('retry-after'));

  const verifiedSenderHint =
    ' — verify the `from` address belongs to an APPROVED Verified Sender domain in the Twilio console';

  let code: NormalizedProviderFailure['code'] = 'PROVIDER_FAILED';
  let message: string;
  if (response.status === 401) {
    code = 'AUTH_FAILED';
    message =
      'Twilio Email authentication failed (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN)' +
      verifiedSenderHint;
  } else if (response.status === 400) {
    message = 'Twilio Email rejected the request (validation)' + verifiedSenderHint;
  } else if (response.status === 429) {
    message = 'Twilio Email rate limited';
  } else {
    message = 'Twilio Email provider failed';
  }

  return {
    code,
    message,
    status: response.status,
    providerBody,
    providerCode,
    // 429 + 5xx are transient per Twilio's own guidance; 400/401 are permanent
    // (a bad payload or an unapproved sender does not fix itself on retry).
    retriable: response.status === 429 || response.status >= 500,
    retryAfterSeconds,
    providerRequestId: requestId,
  };
}

// fetch has NO default timeout — a Twilio latency spike would hang every
// notification send and delivery worker with no upper bound. Same 15s bound
// the SendGrid/SMS legs use.
const DELIVERY_REQUEST_TIMEOUT_MS = 15_000;

/** Twilio explicitly does not support Unicode in the `from` field. */
const NON_ASCII = /[^\x20-\x7E]/;

/**
 * Email half of MessageDeliveryProvider. Deliberately NOT a full provider —
 * there is no Twilio-Email SMS. It is composed into TwilioDeliveryProvider
 * (see its `twilioEmail` config leg) so app.ts keeps ONE base delivery object
 * for PerTenantTwilioDeliveryProvider.sendEmail to delegate to.
 */
export class TwilioEmailDeliveryProvider implements Pick<MessageDeliveryProvider, 'sendEmail'> {
  private readonly config: Required<Omit<TwilioEmailConfig, 'fetchImpl' | 'fromName'>> & {
    fromName?: string;
    fetchImpl: typeof fetch;
  };

  constructor(config: TwilioEmailConfig) {
    if (!config.accountSid || !config.authToken || !config.fromAddress) {
      throw new Error('TwilioEmailDeliveryProvider: missing Twilio email credentials');
    }
    this.config = {
      accountSid: config.accountSid,
      authToken: config.authToken,
      fromAddress: config.fromAddress,
      fromName: config.fromName,
      apiBaseUrl: config.apiBaseUrl ?? 'https://comms.twilio.com/v1',
      fetchImpl: config.fetchImpl ?? fetch,
    };
  }

  async sendEmail(message: EmailMessage): Promise<DeliveryResult> {
    const cfg = this.config;
    const fromAddress = message.from ?? cfg.fromAddress;

    // Fail before the network call with a message an operator can act on,
    // rather than eating an opaque 400 from Twilio.
    if (NON_ASCII.test(fromAddress) || (cfg.fromName && NON_ASCII.test(cfg.fromName))) {
      throw new DeliveryError(
        'PROVIDER_FAILED',
        'Twilio Email does not support Unicode in the `from` field — use an ASCII sender address and name'
      );
    }

    const payload: Record<string, unknown> = {
      from: cfg.fromName ? { address: fromAddress, name: cfg.fromName } : { address: fromAddress },
      to: [{ address: message.to }],
      content: {
        subject: message.subject,
        // `text` is required on EmailMessage; `html` is the preferred body when
        // present. Twilio accepts either or both under `content`.
        text: message.text,
        ...(message.html ? { html: message.html } : {}),
      },
    };

    // HTTP Basic with the SMS credentials — no new secret, by design.
    const auth = Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString('base64');
    const headers: Record<string, string> = {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
    };

    const response = await cfg.fetchImpl(`${cfg.apiBaseUrl}/Emails`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(DELIVERY_REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const providerBody = text.slice(0, 300);
      const failure = classifyTwilioEmailError(response, providerBody);
      throw new DeliveryError(failure.code, failure.message, failure);
    }

    // 202 Accepted → queued for send. `operationId` is the poll handle.
    const data = (await response.json().catch(() => ({}))) as TwilioEmailAcceptedResponse;
    const providerMessageId = data.operationId ?? `twe-${Date.now()}`;

    return {
      providerMessageId,
      // Distinct from 'email-gateway' (SendGrid) so message_dispatches rows are
      // attributable to the provider that actually carried the message.
      provider: 'twilio-email',
      channel: 'email',
    };
  }
}

/**
 * Which email provider a given environment selects. Pure so app.ts's wiring
 * decision is unit-testable without booting createApp().
 *
 *   - Twilio-native when TWILIO_EMAIL_FROM_ADDRESS is set (plus the Twilio
 *     credentials it reuses).
 *   - SendGrid when SENDGRID_API_KEY + SENDGRID_FROM_EMAIL are set.
 *   - 'none' otherwise — email is unconfigured and TwilioDeliveryProvider
 *     throws loudly at send time rather than silently dropping the message.
 *
 * When BOTH are complete, Twilio-native wins DETERMINISTICALLY: it is the
 * newer, explicitly-opted-into path, and it is the one whose credentials this
 * deployment actually has. app.ts logs the choice at boot so the decision is
 * never invisible.
 */
export function selectEmailProvider(
  env: Record<string, string | undefined>
): 'twilio-email' | 'sendgrid' | 'none' {
  const twilioEmailConfigured = !!(
    env.TWILIO_ACCOUNT_SID &&
    env.TWILIO_AUTH_TOKEN &&
    env.TWILIO_EMAIL_FROM_ADDRESS
  );
  if (twilioEmailConfigured) return 'twilio-email';
  if (env.SENDGRID_API_KEY && env.SENDGRID_FROM_EMAIL) return 'sendgrid';
  return 'none';
}
