import {
  DeliveryResult,
  EmailMessage,
  MessageDeliveryProvider,
  SmsMessage,
} from "./delivery-provider";
import { DeliveryError } from "./notification-errors";
import {
  TwilioEmailConfig,
  TwilioEmailDeliveryProvider,
} from "./twilio-email-delivery-provider";

/**
 * Production message delivery via Twilio.
 *
 * SMS uses Twilio Programmable Messaging (the same API the existing
 * feedback dispatcher uses). Email has TWO possible backends, selected
 * by which credentials the deployment actually has:
 *   - `twilioEmail` — Twilio's native Email API (comms.twilio.com), which
 *     reuses the SMS Account SID + Auth Token. See
 *     twilio-email-delivery-provider.ts.
 *   - `email` — Twilio SendGrid v3, which needs its own `SG.` API key.
 * Both channels share account credentials via the parent Twilio billing
 * relationship — operationally we want one vendor to manage, not two.
 *
 * The provider performs the HTTP calls directly with `fetch`. We
 * deliberately don't pull in `twilio` and `@sendgrid/mail` SDKs:
 *   1) two extra deps for thin wrappers around HTTP
 *   2) version compatibility headaches at deploy time
 *   3) the request shape is tiny and stable
 *
 * Failures throw — the caller (route handler or proposal executor)
 * decides whether to retry, surface to UI, or move to dead-letter.
 */

export interface TwilioSmsConfig {
  accountSid: string;
  authToken: string;
  secondaryAuthToken?: string;
  fromNumber: string;
  /** Override for tests. Defaults to Twilio's REST API host. */
  apiBaseUrl?: string;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

export interface SendGridConfig {
  apiKey: string;
  fromEmail: string;
  /** Display name shown alongside fromEmail. */
  fromName?: string;
  /** Optional default reply-to. */
  replyToEmail?: string;
  /** Override for tests. Defaults to SendGrid v3 API. */
  apiBaseUrl?: string;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

/**
 * The two legs are INDEPENDENT and each is optional.
 *
 * Previously both were required, so a deployment with Twilio credentials but
 * no SendGrid credentials could not send SMS at all — the constructor threw,
 * app.ts fell through to `rawMessageDelivery = null`, and every SMS path went
 * dark for want of an *email* key. Omitting a leg now configures a
 * single-channel provider; the unconfigured channel fails loudly at send time
 * (`DeliveryError('AUTH_FAILED', ...)`, the same error shape a rejected
 * credential produces) rather than silently dropping the message.
 *
 * Supplying a leg with blank/partial credentials still throws at construction:
 * that is a misconfiguration, not an intentional opt-out.
 */
export interface TwilioDeliveryProviderConfig {
  sms?: TwilioSmsConfig;
  /** SendGrid email leg. Needs its own `SG.` API key. */
  email?: SendGridConfig;
  /**
   * Twilio-native email leg (comms.twilio.com/v1/Emails). Reuses the SMS
   * Account SID + Auth Token — no new credential. Takes precedence over
   * `email` if both are somehow supplied; app.ts picks exactly one and logs
   * the choice at boot, so this is only a deterministic tiebreak.
   */
  twilioEmail?: TwilioEmailConfig;
}

interface TwilioMessageResponse {
  sid: string;
  status: string;
  error_code?: number;
  error_message?: string;
}

/**
 * Hard ceiling on a single outbound SMS HTTP call. Without it a hung Twilio
 * socket keeps the caller's promise pending forever, which on the E1
 * life-safety path would park the tenant alert behind an unbounded wait.
 * Matches SMS_BEFORE_BRIDGE_TIMEOUT_MS in the voice-turn processor — a late
 * text beats a stuck request.
 */
export const SMS_SEND_TIMEOUT_MS = 4000;

interface NormalizedProviderFailure {
  code: "AUTH_FAILED" | "PROVIDER_FAILED";
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

function classifyTwilioError(response: Response, providerBody: string): NormalizedProviderFailure {
  const providerCode = response.headers.get("twilio-error-code") ?? undefined;
  const requestId =
    response.headers.get("twilio-request-id") ?? response.headers.get("x-request-id") ?? undefined;
  const retryAfterSeconds = parseRetryAfterSeconds(response.headers.get("retry-after"));
  const code = response.status === 401 ? "AUTH_FAILED" : "PROVIDER_FAILED";
  const message = response.status === 401 ? "SMS authentication failed" : "SMS provider failed";
  return {
    code,
    message,
    status: response.status,
    providerBody,
    providerCode,
    retriable: response.status === 429 || response.status >= 500,
    retryAfterSeconds,
    providerRequestId: requestId,
  };
}

function classifySendgridError(response: Response, providerBody: string): NormalizedProviderFailure {
  const providerCode = response.headers.get("x-sendgrid-error-code") ?? undefined;
  const requestId = response.headers.get("x-request-id") ?? undefined;
  const retryAfterSeconds = parseRetryAfterSeconds(response.headers.get("retry-after"));
  const code = response.status === 401 ? "AUTH_FAILED" : "PROVIDER_FAILED";
  const message = response.status === 401 ? "Email authentication failed" : "Email provider failed";
  return {
    code,
    message,
    status: response.status,
    providerBody,
    providerCode,
    retriable: response.status === 429 || response.status >= 500,
    retryAfterSeconds,
    providerRequestId: requestId,
  };
}

// fetch has NO default timeout — a Twilio/SendGrid latency spike would hang
// every notification send and delivery worker with no upper bound.
const DELIVERY_REQUEST_TIMEOUT_MS = 15_000;

export class TwilioDeliveryProvider implements MessageDeliveryProvider {
  private readonly smsConfig?: Required<
    Omit<TwilioSmsConfig, "fetchImpl" | "secondaryAuthToken">
  > & {
    fetchImpl: typeof fetch;
    secondaryAuthToken?: string;
  };
  private readonly emailConfig?: Required<
    Omit<SendGridConfig, "fetchImpl" | "fromName" | "replyToEmail">
  > & {
    fromName?: string;
    replyToEmail?: string;
    fetchImpl: typeof fetch;
  };
  /** Twilio-native email leg. Mutually exclusive with `emailConfig` in practice. */
  private readonly twilioEmailProvider?: TwilioEmailDeliveryProvider;

  constructor(config: TwilioDeliveryProviderConfig) {
    if (config.sms) {
      if (
        !config.sms.accountSid ||
        !config.sms.authToken ||
        !config.sms.fromNumber
      ) {
        throw new Error("TwilioDeliveryProvider: missing SMS credentials");
      }
      this.smsConfig = {
        accountSid: config.sms.accountSid,
        authToken: config.sms.authToken,
        secondaryAuthToken: config.sms.secondaryAuthToken,
        fromNumber: config.sms.fromNumber,
        apiBaseUrl: config.sms.apiBaseUrl ?? "https://api.twilio.com/2010-04-01",
        fetchImpl: config.sms.fetchImpl ?? fetch,
      };
    }
    if (config.email) {
      if (!config.email.apiKey || !config.email.fromEmail) {
        throw new Error("TwilioDeliveryProvider: missing SendGrid credentials");
      }
      this.emailConfig = {
        apiKey: config.email.apiKey,
        fromEmail: config.email.fromEmail,
        fromName: config.email.fromName,
        replyToEmail: config.email.replyToEmail,
        apiBaseUrl: config.email.apiBaseUrl ?? "https://api.sendgrid.com/v3",
        fetchImpl: config.email.fetchImpl ?? fetch,
      };
    }
    if (config.twilioEmail) {
      // Throws on blank/partial creds — same misconfiguration-vs-opt-out rule
      // the sms/email legs use.
      this.twilioEmailProvider = new TwilioEmailDeliveryProvider(config.twilioEmail);
    }
    if (!this.smsConfig && !this.emailConfig && !this.twilioEmailProvider) {
      throw new Error(
        "TwilioDeliveryProvider: at least one of sms/email must be configured",
      );
    }
  }

  /** True when this provider can actually send on the given channel. */
  supports(channel: "sms" | "email"): boolean {
    return channel === "sms"
      ? !!this.smsConfig
      : !!this.twilioEmailProvider || !!this.emailConfig;
  }

  async sendSms(message: SmsMessage): Promise<DeliveryResult> {
    const sms = this.smsConfig;
    if (!sms) {
      // Loud, not silent: an SMS attempted on an email-only deployment is a
      // wiring bug, and a swallowed no-op would look like a delivered message.
      throw new DeliveryError(
        "AUTH_FAILED",
        "SMS is not configured (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM_NUMBER)",
      );
    }
    const body = new URLSearchParams({
      To: message.to,
      From: sms.fromNumber,
      Body: message.body,
    });

    const auth = Buffer.from(
      `${sms.accountSid}:${sms.authToken}`,
    ).toString("base64");
    const headers: Record<string, string> = {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    };
    if (message.idempotencyKey) {
      // Twilio accepts an Idempotency-Key header on Messages.json
      headers["Idempotency-Key"] = message.idempotencyKey;
    }

    // SMS_SEND_TIMEOUT_MS (4s), not the generic 15s delivery ceiling: the E1
    // life-safety tenant alert rides this path and must never park behind a
    // hung Twilio socket. An AbortSignal timeout rejects with a DOMException,
    // not a DeliveryError, so callers branching on `instanceof DeliveryError`
    // (send-service's mapDeliveryErrorForClient, retry classification) would
    // see an unclassified error. Normalize it here so the timeout stays a
    // first-class, retriable provider failure.
    let response: Response;
    try {
      response = await sms.fetchImpl(
        `${sms.apiBaseUrl}/Accounts/${sms.accountSid}/Messages.json`,
        {
          method: "POST",
          headers,
          body: body.toString(),
          signal: AbortSignal.timeout(SMS_SEND_TIMEOUT_MS),
        },
      );
    } catch (err) {
      if (err instanceof DeliveryError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      const aborted =
        err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      // Other throws (DNS failure, a test tripwire fetch, …) stay a
      // DeliveryError too, but KEEP their original message — callers and
      // tests must be able to see what actually failed.
      throw new DeliveryError(
        "PROVIDER_FAILED",
        aborted ? "SMS provider timed out" : `SMS provider failed: ${message}`,
        { providerBody: message },
      );
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const providerBody = text.slice(0, 300);
      const failure = classifyTwilioError(response, providerBody);
      throw new DeliveryError(failure.code, failure.message, failure);
    }

    const data = (await response.json()) as TwilioMessageResponse;
    if (data.error_code) {
      throw new DeliveryError("PROVIDER_FAILED", "SMS provider rejected", {
        status: response.status,
        providerBody: `${data.error_code} ${data.error_message ?? ""}`.trim(),
      });
    }

    return {
      providerMessageId: data.sid,
      provider: "sms-gateway",
      channel: "sms",
    };
  }

  async sendEmail(message: EmailMessage): Promise<DeliveryResult> {
    // Twilio-native email wins deterministically when both legs are present.
    // app.ts selects exactly one and logs it, so this only decides the
    // pathological both-configured case.
    if (this.twilioEmailProvider) {
      return this.twilioEmailProvider.sendEmail(message);
    }
    const email = this.emailConfig;
    if (!email) {
      // Loud, not silent — same rationale as sendSms above.
      throw new DeliveryError(
        "AUTH_FAILED",
        "Email is not configured (set TWILIO_EMAIL_FROM_ADDRESS for Twilio-native email, " +
          "or SENDGRID_API_KEY / SENDGRID_FROM_EMAIL for SendGrid)",
      );
    }
    const fromEmail = message.from ?? email.fromEmail;
    const replyToEmail = message.replyTo ?? email.replyToEmail;

    const content: Array<{ type: string; value: string }> = [
      { type: "text/plain", value: message.text },
    ];
    if (message.html) {
      content.push({ type: "text/html", value: message.html });
    }

    const payload: Record<string, unknown> = {
      personalizations: [{ to: [{ email: message.to }] }],
      from: email.fromName
        ? { email: fromEmail, name: email.fromName }
        : { email: fromEmail },
      subject: message.subject,
      content,
    };
    if (replyToEmail) {
      payload.reply_to = { email: replyToEmail };
    }
    if (message.tenantId) {
      payload.custom_args = { tenant_id: message.tenantId };
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${email.apiKey}`,
      "Content-Type": "application/json",
    };
    if (message.idempotencyKey) {
      // SendGrid honours `X-Message-Id` for idempotent semantics on retries.
      headers["X-Message-Id"] = message.idempotencyKey;
    }

    const response = await email.fetchImpl(
      `${email.apiBaseUrl}/mail/send`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(DELIVERY_REQUEST_TIMEOUT_MS),
      },
    );

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const providerBody = text.slice(0, 300);
      const failure = classifySendgridError(response, providerBody);
      throw new DeliveryError(failure.code, failure.message, failure);
    }

    // SendGrid returns 202 Accepted with the message ID in `X-Message-Id`.
    const providerMessageId =
      response.headers.get("x-message-id") ?? `sg-${Date.now()}`;

    return {
      providerMessageId,
      provider: "email-gateway",
      channel: "email",
    };
  }
}
