import {
  DeliveryResult,
  EmailMessage,
  MessageDeliveryProvider,
  SmsMessage,
} from "./delivery-provider";
import { DeliveryError } from "./notification-errors";

/**
 * Production message delivery via Twilio.
 *
 * SMS uses Twilio Programmable Messaging (the same API the existing
 * feedback dispatcher uses). Email uses Twilio SendGrid v3. Both
 * channels share account credentials via the parent Twilio billing
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

export interface TwilioDeliveryProviderConfig {
  sms: TwilioSmsConfig;
  email: SendGridConfig;
}

interface TwilioMessageResponse {
  sid: string;
  status: string;
  error_code?: number;
  error_message?: string;
}

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

export class TwilioDeliveryProvider implements MessageDeliveryProvider {
  private readonly sms: Required<
    Omit<TwilioSmsConfig, "fetchImpl" | "secondaryAuthToken">
  > & {
    fetchImpl: typeof fetch;
    secondaryAuthToken?: string;
  };
  private readonly email: Required<
    Omit<SendGridConfig, "fetchImpl" | "fromName" | "replyToEmail">
  > & {
    fromName?: string;
    replyToEmail?: string;
    fetchImpl: typeof fetch;
  };

  constructor(config: TwilioDeliveryProviderConfig) {
    if (
      !config.sms.accountSid ||
      !config.sms.authToken ||
      !config.sms.fromNumber
    ) {
      throw new Error("TwilioDeliveryProvider: missing SMS credentials");
    }
    if (!config.email.apiKey || !config.email.fromEmail) {
      throw new Error("TwilioDeliveryProvider: missing SendGrid credentials");
    }

    this.sms = {
      accountSid: config.sms.accountSid,
      authToken: config.sms.authToken,
      secondaryAuthToken: config.sms.secondaryAuthToken,
      fromNumber: config.sms.fromNumber,
      apiBaseUrl: config.sms.apiBaseUrl ?? "https://api.twilio.com/2010-04-01",
      fetchImpl: config.sms.fetchImpl ?? fetch,
    };
    this.email = {
      apiKey: config.email.apiKey,
      fromEmail: config.email.fromEmail,
      fromName: config.email.fromName,
      replyToEmail: config.email.replyToEmail,
      apiBaseUrl: config.email.apiBaseUrl ?? "https://api.sendgrid.com/v3",
      fetchImpl: config.email.fetchImpl ?? fetch,
    };
  }

  async sendSms(message: SmsMessage): Promise<DeliveryResult> {
    const body = new URLSearchParams({
      To: message.to,
      From: this.sms.fromNumber,
      Body: message.body,
    });

    const auth = Buffer.from(
      `${this.sms.accountSid}:${this.sms.authToken}`,
    ).toString("base64");
    const headers: Record<string, string> = {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    };
    if (message.idempotencyKey) {
      // Twilio accepts an Idempotency-Key header on Messages.json
      headers["Idempotency-Key"] = message.idempotencyKey;
    }

    let response = await this.sms.fetchImpl(
      `${this.sms.apiBaseUrl}/Accounts/${this.sms.accountSid}/Messages.json`,
      {
        method: "POST",
        headers,
        body: body.toString(),
      },
    );

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const providerBody = text.slice(0, 300);
      const failure = classifyTwilioError(response, providerBody);
      throw new DeliveryError(failure.code, failure.message, failure);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const detail = '(' + response.status + '): ' + text.slice(0, 300);
      if (response.status === 401) {
        throw new Error('DELIVERY_AUTH_FAILED ' + detail);
      }
      throw new Error('DELIVERY_PROVIDER_FAILED ' + detail);
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
    const fromEmail = message.from ?? this.email.fromEmail;
    const replyToEmail = message.replyTo ?? this.email.replyToEmail;

    const content: Array<{ type: string; value: string }> = [
      { type: "text/plain", value: message.text },
    ];
    if (message.html) {
      content.push({ type: "text/html", value: message.html });
    }

    const payload: Record<string, unknown> = {
      personalizations: [{ to: [{ email: message.to }] }],
      from: this.email.fromName
        ? { email: fromEmail, name: this.email.fromName }
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
      Authorization: `Bearer ${this.email.apiKey}`,
      "Content-Type": "application/json",
    };
    if (message.idempotencyKey) {
      // SendGrid honours `X-Message-Id` for idempotent semantics on retries.
      headers["X-Message-Id"] = message.idempotencyKey;
    }

    const response = await this.email.fetchImpl(
      `${this.email.apiBaseUrl}/mail/send`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
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
