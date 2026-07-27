/**
 * Twilio-NATIVE email (comms.twilio.com/v1/Emails) — the email backend for a
 * deployment that has Twilio credentials and no SendGrid key.
 *
 * The bar these tests hold:
 *   - the wire format is EXACTLY Twilio's: URL, HTTP Basic with the SMS
 *     credentials, and the from/to/content body (not SendGrid's
 *     personalizations/content).
 *   - 202 Accepted is success-QUEUED and `operationId` becomes the
 *     providerMessageId, so message_dispatches keeps a poll handle.
 *   - the error taxonomy mirrors classifySendgridError: 401 → AUTH_FAILED,
 *     400 → permanent PROVIDER_FAILED with the validation body surfaced,
 *     429/5xx → retryable PROVIDER_FAILED.
 *   - the kill switch from the preceding commit still suppresses it. It sits
 *     ABOVE this provider in GatedMessageDelivery, so it should — asserted
 *     rather than assumed.
 *
 * SAFETY: every test mocks fetch. Nothing here talks to comms.twilio.com.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  TwilioEmailDeliveryProvider,
  selectEmailProvider,
} from '../../src/notifications/twilio-email-delivery-provider';
import { TwilioDeliveryProvider } from '../../src/notifications/twilio-delivery-provider';
import { DeliveryError } from '../../src/notifications/notification-errors';
import {
  GatedMessageDelivery,
  EmailSuppressedError,
} from '../../src/notifications/gated-message-delivery';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemoryDncRepository } from '../../src/compliance/dnc';

const BASE_URL = 'https://test.example/twilio-email';
// Basic auth is base64('AC_test:token_test') — the SAME credentials as SMS.
const EXPECTED_AUTH = `Basic ${Buffer.from('AC_test:token_test').toString('base64')}`;

function makeProvider(fetchImpl: typeof fetch, over: Record<string, unknown> = {}) {
  return new TwilioEmailDeliveryProvider({
    accountSid: 'AC_test',
    authToken: 'token_test',
    fromAddress: 'support@acmehvac.com',
    fromName: 'Acme HVAC',
    apiBaseUrl: BASE_URL,
    fetchImpl,
    ...over,
  });
}

function accepted(body: unknown = {
  operationId: 'OP_abc123',
  operationLocation: 'https://comms.twilio.com/v1/Emails/Operations/OP_abc123',
}) {
  return new Response(JSON.stringify(body), {
    status: 202,
    headers: { 'content-type': 'application/json' },
  });
}

describe('TwilioEmailDeliveryProvider — request shape', () => {
  it('POSTs Twilio\'s from/to/content body to /Emails with basic auth', async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('https://test.example/twilio-email/Emails');
      expect(init.method).toBe('POST');
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe(EXPECTED_AUTH);
      expect(headers['Content-Type']).toBe('application/json');
      // The whole body, not a subset — a stray SendGrid-shaped key would 400.
      expect(JSON.parse(init.body as string)).toEqual({
        from: { address: 'support@acmehvac.com', name: 'Acme HVAC' },
        to: [{ address: 'customer@example.com' }],
        content: {
          subject: 'Your invoice',
          text: 'Plain body',
          html: '<p>HTML</p>',
        },
      });
      return accepted();
    });

    const provider = makeProvider(fetchImpl as unknown as typeof fetch);
    const result = await provider.sendEmail({
      to: 'customer@example.com',
      subject: 'Your invoice',
      text: 'Plain body',
      html: '<p>HTML</p>',
    });

    expect(result).toEqual({
      providerMessageId: 'OP_abc123',
      provider: 'twilio-email',
      channel: 'email',
    });
  });

  it('omits html when the message has none, and name when unconfigured', async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      expect(JSON.parse(init.body as string)).toEqual({
        from: { address: 'support@acmehvac.com' },
        to: [{ address: 'a@b.com' }],
        content: { subject: 's', text: 't' },
      });
      return accepted();
    });
    const provider = makeProvider(fetchImpl as unknown as typeof fetch, {
      fromName: undefined,
    });
    await provider.sendEmail({ to: 'a@b.com', subject: 's', text: 't' });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('honours a per-message from override', async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      expect(body.from.address).toBe('billing@acmehvac.com');
      return accepted();
    });
    const provider = makeProvider(fetchImpl as unknown as typeof fetch);
    await provider.sendEmail({
      to: 'a@b.com',
      subject: 's',
      text: 't',
      from: 'billing@acmehvac.com',
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('defaults apiBaseUrl to Twilio\'s Email API host', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe('https://comms.twilio.com/v1/Emails');
      return accepted();
    });
    const provider = new TwilioEmailDeliveryProvider({
      accountSid: 'AC_test',
      authToken: 'token_test',
      fromAddress: 'support@acmehvac.com',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await provider.sendEmail({ to: 'a@b.com', subject: 's', text: 't' });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});

describe('TwilioEmailDeliveryProvider — 202 Accepted (queued, NOT delivered)', () => {
  it('uses operationId as providerMessageId', async () => {
    const fetchImpl = vi.fn(async () =>
      accepted({ operationId: 'OP_zzz', operationLocation: 'https://x/OP_zzz' })
    ) as unknown as typeof fetch;
    const result = await makeProvider(fetchImpl).sendEmail({
      to: 'a@b.com',
      subject: 's',
      text: 't',
    });
    expect(result.providerMessageId).toBe('OP_zzz');
    expect(result.channel).toBe('email');
  });

  it('falls back to a synthetic id when the 202 body carries no operationId', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 202 })) as unknown as typeof fetch;
    const result = await makeProvider(fetchImpl).sendEmail({
      to: 'a@b.com',
      subject: 's',
      text: 't',
    });
    expect(result.providerMessageId).toMatch(/^twe-\d+$/);
    expect(result.provider).toBe('twilio-email');
  });
});

describe('TwilioEmailDeliveryProvider — error taxonomy', () => {
  async function failWith(response: Response) {
    const fetchImpl = vi.fn(async () => response) as unknown as typeof fetch;
    const provider = makeProvider(fetchImpl);
    return provider.sendEmail({ to: 'a@b.com', subject: 's', text: 't' }).catch((e) => e);
  }

  it('401 → AUTH_FAILED, naming the credentials AND the Verified Sender', async () => {
    const err = await failWith(new Response('Unauthorized', { status: 401 }));
    expect(err).toBeInstanceOf(DeliveryError);
    expect(err).toMatchObject({
      code: 'AUTH_FAILED',
      status: 401,
      providerBody: 'Unauthorized',
    });
    // A 401 in production is far more likely an unapproved sender than a bug;
    // the message has to make that diagnosable from the log line alone.
    expect(err.message).toMatch(/TWILIO_ACCOUNT_SID/);
    expect(err.message).toMatch(/Verified Sender/);
  });

  it('400 → permanent PROVIDER_FAILED, surfacing the validation body', async () => {
    const err = await failWith(
      new Response('{"errors":[{"field":"from.address","message":"sender not verified"}]}', {
        status: 400,
      })
    );
    expect(err).toMatchObject({ code: 'PROVIDER_FAILED', status: 400 });
    expect(err.providerBody).toContain('sender not verified');
    expect(err.message).toMatch(/Verified Sender/);
  });

  it('429 → PROVIDER_FAILED with Retry-After and the request id', async () => {
    const err = await failWith(
      new Response('Too many requests', {
        status: 429,
        headers: { 'retry-after': '11', 'twilio-request-id': 'tw-req-429' },
      })
    );
    expect(err).toMatchObject({
      code: 'PROVIDER_FAILED',
      status: 429,
      retryAfterSeconds: 11,
      providerRequestId: 'tw-req-429',
    });
  });

  it('500 and 503 → PROVIDER_FAILED (transient)', async () => {
    for (const status of [500, 503]) {
      const err = await failWith(new Response('boom', { status }));
      expect(err).toMatchObject({ code: 'PROVIDER_FAILED', status });
      expect(err).toBeInstanceOf(DeliveryError);
    }
  });

  it('truncates an oversized provider body to 300 chars', async () => {
    const err = await failWith(new Response('x'.repeat(1000), { status: 400 }));
    expect(err.providerBody).toHaveLength(300);
  });

  it('rejects a Unicode from address BEFORE the network call', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const provider = makeProvider(fetchImpl);
    const err = await provider
      .sendEmail({ to: 'a@b.com', subject: 's', text: 't', from: 'sopporté@acmehvac.com' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(DeliveryError);
    expect(err.message).toMatch(/Unicode/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('TwilioEmailDeliveryProvider — config validation', () => {
  it.each([
    ['accountSid', { accountSid: '' }],
    ['authToken', { authToken: '' }],
    ['fromAddress', { fromAddress: '' }],
  ])('throws on blank %s (misconfiguration, not an opt-out)', (_name, over) => {
    expect(() =>
      new TwilioEmailDeliveryProvider({
        accountSid: 'AC',
        authToken: 't',
        fromAddress: 'a@b.com',
        ...over,
      })
    ).toThrow(/missing Twilio email credentials/);
  });
});

describe('selectEmailProvider — the app.ts wiring rule', () => {
  const twilio = { TWILIO_ACCOUNT_SID: 'AC7x', TWILIO_AUTH_TOKEN: 'tok' };
  const sendgrid = { SENDGRID_API_KEY: 'SG.x', SENDGRID_FROM_EMAIL: 'noreply@example.com' };

  it('picks Twilio-native when TWILIO_EMAIL_FROM_ADDRESS is set', () => {
    expect(
      selectEmailProvider({ ...twilio, TWILIO_EMAIL_FROM_ADDRESS: 'support@acmehvac.com' })
    ).toBe('twilio-email');
  });

  it('picks SendGrid when only SendGrid is configured', () => {
    expect(selectEmailProvider({ ...twilio, ...sendgrid })).toBe('sendgrid');
  });

  it('picks Twilio-native DETERMINISTICALLY when both are configured', () => {
    expect(
      selectEmailProvider({
        ...twilio,
        ...sendgrid,
        TWILIO_EMAIL_FROM_ADDRESS: 'support@acmehvac.com',
      })
    ).toBe('twilio-email');
  });

  it('returns none when neither is configured', () => {
    expect(selectEmailProvider({ ...twilio })).toBe('none');
    expect(selectEmailProvider({})).toBe('none');
  });

  it('does not pick Twilio-native on a PARTIAL Twilio config', () => {
    // From-address without the credentials it reuses is not a usable backend.
    expect(
      selectEmailProvider({ TWILIO_EMAIL_FROM_ADDRESS: 'support@acmehvac.com', ...sendgrid })
    ).toBe('sendgrid');
    expect(
      selectEmailProvider({
        TWILIO_ACCOUNT_SID: 'AC7x',
        TWILIO_EMAIL_FROM_ADDRESS: 'support@acmehvac.com',
      })
    ).toBe('none');
  });

  it('ignores a SendGrid key with no from address (and vice versa)', () => {
    expect(selectEmailProvider({ SENDGRID_API_KEY: 'SG.x' })).toBe('none');
    expect(selectEmailProvider({ SENDGRID_FROM_EMAIL: 'noreply@example.com' })).toBe('none');
  });
});

describe('TwilioDeliveryProvider — composed twilioEmail leg', () => {
  it('routes sendEmail to comms.twilio.com and keeps SMS on Twilio Messages', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(url);
      if (url.endsWith('/Emails')) return accepted();
      return new Response(JSON.stringify({ sid: 'SM_x', status: 'queued' }), { status: 201 });
    }) as unknown as typeof fetch;

    const provider = new TwilioDeliveryProvider({
      sms: {
        accountSid: 'AC_test',
        authToken: 'token_test',
        fromNumber: '+15555550100',
        apiBaseUrl: 'https://test.example/twilio',
        fetchImpl,
      },
      twilioEmail: {
        accountSid: 'AC_test',
        authToken: 'token_test',
        fromAddress: 'support@acmehvac.com',
        apiBaseUrl: BASE_URL,
        fetchImpl,
      },
    });

    expect(provider.supports('sms')).toBe(true);
    expect(provider.supports('email')).toBe(true);

    const emailResult = await provider.sendEmail({ to: 'a@b.com', subject: 's', text: 't' });
    expect(emailResult.provider).toBe('twilio-email');
    const smsResult = await provider.sendSms({
      to: '+15555550199',
      body: 'x',
      recipientClass: 'owner',
    });
    expect(smsResult.provider).toBe('sms-gateway');

    expect(calls).toEqual([
      'https://test.example/twilio-email/Emails',
      'https://test.example/twilio/Accounts/AC_test/Messages.json',
    ]);
  });

  it('constructs email-only (no SMS creds) and fails SMS loudly', async () => {
    const fetchImpl = vi.fn(async () => accepted()) as unknown as typeof fetch;
    const provider = new TwilioDeliveryProvider({
      twilioEmail: {
        accountSid: 'AC_test',
        authToken: 'token_test',
        fromAddress: 'support@acmehvac.com',
        apiBaseUrl: BASE_URL,
        fetchImpl,
      },
    });
    expect(provider.supports('sms')).toBe(false);
    expect(provider.supports('email')).toBe(true);
    await expect(
      provider.sendSms({ to: '+1555', body: 'x', recipientClass: 'owner' })
    ).rejects.toThrow(/SMS is not configured/);
  });

  it('prefers Twilio-native over SendGrid when both legs are somehow supplied', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe('https://test.example/twilio-email/Emails');
      return accepted();
    }) as unknown as typeof fetch;
    const provider = new TwilioDeliveryProvider({
      email: {
        apiKey: 'SG.test',
        fromEmail: 'team@acmehvac.com',
        apiBaseUrl: 'https://test.example/sendgrid',
        fetchImpl,
      },
      twilioEmail: {
        accountSid: 'AC_test',
        authToken: 'token_test',
        fromAddress: 'support@acmehvac.com',
        apiBaseUrl: BASE_URL,
        fetchImpl,
      },
    });
    const result = await provider.sendEmail({ to: 'a@b.com', subject: 's', text: 't' });
    expect(result.provider).toBe('twilio-email');
  });

  it('names BOTH backends in the unconfigured-email error', async () => {
    const provider = new TwilioDeliveryProvider({
      sms: {
        accountSid: 'AC_test',
        authToken: 'token_test',
        fromNumber: '+15555550100',
        fetchImpl: vi.fn() as unknown as typeof fetch,
      },
    });
    const err = await provider
      .sendEmail({ to: 'a@b.com', subject: 's', text: 't' })
      .catch((e) => e);
    expect(err).toMatchObject({ code: 'AUTH_FAILED' });
    expect(err.message).toMatch(/TWILIO_EMAIL_FROM_ADDRESS/);
    expect(err.message).toMatch(/SENDGRID_API_KEY/);
  });
});

describe('kill switch still suppresses Twilio-native email', () => {
  function gateOver(fetchImpl: typeof fetch, env: NodeJS.ProcessEnv) {
    const base = new TwilioDeliveryProvider({
      twilioEmail: {
        accountSid: 'AC_test',
        authToken: 'token_test',
        fromAddress: 'support@acmehvac.com',
        apiBaseUrl: BASE_URL,
        fetchImpl,
      },
    });
    return new GatedMessageDelivery({
      base,
      dnc: new InMemoryDncRepository(),
      auditRepo: new InMemoryAuditRepository(),
      enforcement: 'block',
      env,
      logger: { info: () => {} },
    });
  }

  it('EMAIL_ENABLED=false suppresses BEFORE any HTTP call reaches Twilio', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const gate = gateOver(fetchImpl, { EMAIL_ENABLED: 'false' });
    await expect(
      gate.sendEmail({ to: 'a@b.com', subject: 's', text: 't', tenantId: 'tenant-1' })
    ).rejects.toBeInstanceOf(EmailSuppressedError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('EMAIL_ENABLED unset lets the send through to the Twilio Email API', async () => {
    const fetchImpl = vi.fn(async () => accepted()) as unknown as typeof fetch;
    const gate = gateOver(fetchImpl, {});
    const result = await gate.sendEmail({
      to: 'a@b.com',
      subject: 's',
      text: 't',
      tenantId: 'tenant-1',
    });
    expect(result.provider).toBe('twilio-email');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
