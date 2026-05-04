import {
  DeliveryResult,
  EmailMessage,
  MessageDeliveryProvider,
  SmsMessage,
} from './delivery-provider';
import { DeliveryError } from './notification-errors';

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

type InternalTwilioSmsConfig = {
  accountSid: string;
  authToken: string;
  fromNumber: string;
  apiBaseUrl: string;
  fetchImpl: typeof fetch;
  authTokenSecondary?: string;
};

export class TwilioDeliveryProvider implements MessageDeliveryProvider {
  private readonly sms: Omit<TwilioSmsConfig, 'fetchImpl'> & {
    apiBaseUrl: string;
    fetchImpl: typeof fetch;
  };
  private readonly email: Required<Omit<SendGridConfig, 'fetchImpl' | 'fromName' | 'replyToEmail'>> & {
    fromName?: string;
    replyToEmail?: string;
    fetchImpl: typeof fetch;
  };

  constructor(config: TwilioDeliveryProviderConfig) {
    if (!config.sms.accountSid || !config.sms.authToken || !config.sms.fromNumber) {
      throw new Error('TwilioDeliveryProvider: missing SMS credentials');
    }
    if (!config.email.apiKey || !config.email.fromEmail) {
      throw new Error('TwilioDeliveryProvider: missing SendGrid credentials');
    }

    this.sms = {
      accountSid: config.sms.accountSid,
      authToken: config.sms.authToken,
      authTokenSecondary: config.sms.authTokenSecondary,
      fromNumber: config.sms.fromNumber,
      secondaryAuthToken: config.sms.secondaryAuthToken,
      apiBaseUrl: config.sms.apiBaseUrl ?? 'https://api.twilio.com/2010-04-01',
      fetchImpl: config.sms.fetchImpl ?? fetch,
    };
    this.email = {
      apiKey: config.email.apiKey,
      fromEmail: config.email.fromEmail,
      fromName: config.email.fromName,
      replyToEmail: config.email.replyToEmail,
      apiBaseUrl: config.email.apiBaseUrl ?? 'https://api.sendgrid.com/v3',
      fetchImpl: config.email.fetchImpl ?? fetch,
    };
  }

  async sendSms(message: SmsMessage): Promise<DeliveryResult> {
    const body = new URLSearchParams({
      To: message.to,
      From: this.sms.fromNumber,
      Body: message.body,
    });

    const sendWithToken = async (authToken: string) => {
      const auth = Buffer.from(`${this.sms.accountSid}:${authToken}`).toString('base64');
      const headers: Record<string, string> = {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      };
      if (message.idempotencyKey) {
        headers['Idempotency-Key'] = message.idempotencyKey;
      }

      return this.sms.fetchImpl(
        `${this.sms.apiBaseUrl}/Accounts/${this.sms.accountSid}/Messages.json`,
        { method: 'POST', headers, body: body.toString() }
      );
    };

    let response = await sendWithToken(this.sms.authToken);
    if (response.status === 401 && this.sms.secondaryAuthToken) {
      response = await sendWithToken(this.sms.secondaryAuthToken);
    }

    if (response.status === 401 && this.sms.authTokenSecondary) {
      const secondaryAuth = Buffer.from(`${this.sms.accountSid}:${this.sms.authTokenSecondary}`).toString('base64');
      response = await this.sms.fetchImpl(
        `${this.sms.apiBaseUrl}/Accounts/${this.sms.accountSid}/Messages.json`,
        {
          method: 'POST',
          headers: {
            ...headers,
            Authorization: `Basic ${secondaryAuth}`,
          },
          body: body.toString(),
        }
      );
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const providerBody = text.slice(0, 300);
      throw new DeliveryError(
        response.status === 401 ? 'AUTH_FAILED' : 'PROVIDER_FAILED',
        `Twilio SMS send failed (${response.status})`,
        { status: response.status, providerBody }
      );
    }

    const data = (await response.json()) as TwilioMessageResponse;
    if (data.error_code) {
      throw new DeliveryError(
        'PROVIDER_FAILED',
        `Twilio SMS rejected: ${data.error_code} ${data.error_message ?? ''}`.trim(),
        { providerBody: JSON.stringify(data).slice(0, 300) }
      );
    }

    return {
      providerMessageId: data.sid,
      provider: 'sms-gateway',
      channel: 'sms',
    };
  }

  async sendEmail(message: EmailMessage): Promise<DeliveryResult> {
    const fromEmail = message.from ?? this.email.fromEmail;
    const replyToEmail = message.replyTo ?? this.email.replyToEmail;

    const content: Array<{ type: string; value: string }> = [{ type: 'text/plain', value: message.text }];
    if (message.html) {
      content.push({ type: 'text/html', value: message.html });
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
      'Content-Type': 'application/json',
    };
    if (message.idempotencyKey) {
      // SendGrid honours `X-Message-Id` for idempotent semantics on retries.
      headers['X-Message-Id'] = message.idempotencyKey;
    }

    const response = await this.email.fetchImpl(`${this.email.apiBaseUrl}/mail/send`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const providerBody = text.slice(0, 300);
      throw new DeliveryError(
        response.status === 401 ? 'AUTH_FAILED' : 'PROVIDER_FAILED',
        `SendGrid email send failed (${response.status})`,
        { status: response.status, providerBody }
      );
    }

    // SendGrid returns 202 Accepted with the message ID in `X-Message-Id`.
    const providerMessageId =
      response.headers.get('x-message-id') ?? `sg-${Date.now()}`;

    return {
      providerMessageId,
      provider: 'email-gateway',
      channel: 'email',
    };
  }
}
