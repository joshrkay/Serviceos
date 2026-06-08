/**
 * Feature 7 — Per-tenant outbound notification SMS (launch-readiness pass).
 *
 * Decorates a base MessageDeliveryProvider so that outbound *SMS* resolves
 * Twilio credentials per tenant (via getTenantTwilioCreds against the
 * tenant_integrations row) instead of using one global account. Email is
 * delegated unchanged to the base provider (SendGrid stays global).
 *
 * Fail-closed: a tenant with no usable Twilio credentials raises a
 * DeliveryError rather than silently falling back to another tenant's number
 * or crashing the process. The existing notification callers already treat a
 * thrown DeliveryError as a best-effort skip (appointment confirmations) or a
 * recorded failed dispatch (SendService), so a missing-creds tenant is logged
 * and skipped, never cross-billed and never fatal.
 */
import type { Pool } from 'pg';
import {
  DeliveryResult,
  EmailMessage,
  MessageDeliveryProvider,
  SmsMessage,
} from './delivery-provider';
import { DeliveryError } from './notification-errors';
import { getTenantTwilioCreds, TenantTwilioCreds } from '../integrations/credentials';

interface TwilioMessageResponse {
  sid: string;
  status: string;
  error_code?: number;
  error_message?: string;
}

export interface PerTenantTwilioDeliveryProviderDeps {
  pool: Pool;
  /** Handles email (and SMS sends that carry no tenantId). */
  base: MessageDeliveryProvider;
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Override Twilio REST host for tests. */
  apiBaseUrl?: string;
}

export class PerTenantTwilioDeliveryProvider implements MessageDeliveryProvider {
  private readonly pool: Pool;
  private readonly base: MessageDeliveryProvider;
  private readonly fetchImpl: typeof fetch;
  private readonly apiBaseUrl: string;

  constructor(deps: PerTenantTwilioDeliveryProviderDeps) {
    this.pool = deps.pool;
    this.base = deps.base;
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.apiBaseUrl = deps.apiBaseUrl ?? 'https://api.twilio.com/2010-04-01';
  }

  async sendSms(message: SmsMessage): Promise<DeliveryResult> {
    // Sends without a tenant scope (rare; e.g. platform-level alerts) keep the
    // global account so existing non-tenant flows are unaffected.
    if (!message.tenantId) {
      return this.base.sendSms(message);
    }

    let creds: TenantTwilioCreds;
    try {
      creds = await getTenantTwilioCreds(message.tenantId, this.pool);
    } catch (err) {
      // Fail closed: no active integration for this tenant -> skip, don't
      // borrow another tenant's number and don't crash.
      throw new DeliveryError(
        'AUTH_FAILED',
        `No active Twilio integration for tenant ${message.tenantId}`,
        { providerBody: err instanceof Error ? err.message : String(err) },
      );
    }

    const sender = creds.messagingServiceSid ?? creds.phoneE164;
    if (!creds.accountSid || !creds.authToken || !sender) {
      throw new DeliveryError(
        'AUTH_FAILED',
        `Incomplete Twilio credentials for tenant ${message.tenantId}`,
      );
    }

    const body = new URLSearchParams({ To: message.to, Body: message.body });
    // Prefer a Messaging Service (handles sender pools / compliance) over a
    // bare From number when the tenant has one configured.
    if (creds.messagingServiceSid) {
      body.set('MessagingServiceSid', creds.messagingServiceSid);
    } else {
      body.set('From', creds.phoneE164 as string);
    }

    const auth = Buffer.from(`${creds.accountSid}:${creds.authToken}`).toString('base64');
    const headers: Record<string, string> = {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    };
    if (message.idempotencyKey) {
      headers['Idempotency-Key'] = message.idempotencyKey;
    }

    const response = await this.fetchImpl(
      `${this.apiBaseUrl}/Accounts/${creds.accountSid}/Messages.json`,
      { method: 'POST', headers, body: body.toString() },
    );

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new DeliveryError(
        response.status === 401 ? 'AUTH_FAILED' : 'PROVIDER_FAILED',
        response.status === 401 ? 'SMS authentication failed' : 'SMS provider failed',
        { status: response.status, providerBody: text.slice(0, 300) },
      );
    }

    const data = (await response.json()) as TwilioMessageResponse;
    if (data.error_code) {
      throw new DeliveryError('PROVIDER_FAILED', 'SMS provider rejected', {
        status: response.status,
        providerBody: `${data.error_code} ${data.error_message ?? ''}`.trim(),
      });
    }

    return { providerMessageId: data.sid, provider: 'sms-gateway', channel: 'sms' };
  }

  sendEmail(message: EmailMessage): Promise<DeliveryResult> {
    // Email stays on the global SendGrid account.
    return this.base.sendEmail(message);
  }
}
