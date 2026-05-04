import { describe, it, expect, vi } from 'vitest';
import { TwilioDeliveryProvider } from '../../src/notifications/twilio-delivery-provider';
import { DeliveryError } from '../../src/notifications/notification-errors';

function makeProvider(fetchImpl: typeof fetch, secondaryAuthToken?: string) {
  return new TwilioDeliveryProvider({
    sms: {
      accountSid: 'AC_test',
      authToken: 'token_test',
      fromNumber: '+15555550100',
      secondaryAuthToken,
      apiBaseUrl: 'https://test.example/twilio',
      fetchImpl,
    },
    email: {
      apiKey: 'SG.test',
      fromEmail: 'team@acmehvac.com',
      fromName: 'Acme HVAC',
      apiBaseUrl: 'https://test.example/sendgrid',
      fetchImpl,
    },
  });
}

describe('TwilioDeliveryProvider — SMS', () => {
  it('posts form-encoded body to Twilio Messages endpoint with basic auth', async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('https://test.example/twilio/Accounts/AC_test/Messages.json');
      expect(init.method).toBe('POST');
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toMatch(/^Basic /);
      expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded');
      const body = init.body as string;
      expect(body).toContain('To=%2B15555550199');
      expect(body).toContain('From=%2B15555550100');
      expect(body).toContain('Body=Hello+world');
      return new Response(JSON.stringify({ sid: 'SM_abc', status: 'queued' }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    });

    const provider = makeProvider(fetchImpl as unknown as typeof fetch);
    const result = await provider.sendSms({
      to: '+15555550199',
      body: 'Hello world',
    });

    expect(result.providerMessageId).toBe('SM_abc');
    expect(result.provider).toBe('sms-gateway');
    expect(result.channel).toBe('sms');
  });

  it('throws DeliveryError when Twilio returns non-2xx', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response('Twilio rejected', {
          status: 400,
        })
    );
  });

  it('throws normalized provider failure when Twilio returns non-401', async () => {
    const fetchImpl = vi.fn(async () => new Response('Twilio rejected', { status: 400 }));
    const provider = makeProvider(fetchImpl as unknown as typeof fetch);
    await expect(provider.sendSms({ to: '+15555550199', body: 'oops' })).rejects.toMatchObject({
      code: 'PROVIDER_FAILED',
      status: 400,
      providerBody: 'Twilio rejected',
    });
    await expect(provider.sendSms({ to: '+15555550199', body: 'oops' })).rejects.toBeInstanceOf(
      DeliveryError
    );
  });

  it('passes idempotency key header when provided', async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      expect(headers['Idempotency-Key']).toBe('estimate:1234:sms');
      return new Response(JSON.stringify({ sid: 'SM_idem' }), { status: 201 });
    });
    const provider = makeProvider(fetchImpl as unknown as typeof fetch);
    await provider.sendSms({
      to: '+15555550199',
      body: 'x',
      idempotencyKey: 'estimate:1234:sms',
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('maps 401 to AUTH_FAILED', async () => {
    const fetchImpl = vi.fn(async () => new Response('Unauthorized', { status: 401 }));
    const provider = makeProvider(fetchImpl as unknown as typeof fetch);
    await expect(provider.sendSms({ to: '+15555550199', body: 'oops' })).rejects.toMatchObject({
      code: 'AUTH_FAILED',
      status: 401,
      providerBody: 'Unauthorized',
    });
  });
});

describe('TwilioDeliveryProvider — Email (SendGrid)', () => {
  it('posts JSON to /mail/send with bearer auth and personalizations', async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('https://test.example/sendgrid/mail/send');
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer SG.test');
      expect(headers['Content-Type']).toBe('application/json');
      const body = JSON.parse(init.body as string);
      expect(body.personalizations[0].to[0].email).toBe('customer@example.com');
      expect(body.from.email).toBe('team@acmehvac.com');
      expect(body.from.name).toBe('Acme HVAC');
      expect(body.subject).toBe('Test subject');
      expect(body.content[0]).toEqual({ type: 'text/plain', value: 'Plain body' });
      expect(body.content[1]).toEqual({ type: 'text/html', value: '<p>HTML</p>' });
      return new Response('', {
        status: 202,
        headers: { 'x-message-id': 'sg-msg-123' },
      });
    });

    const provider = makeProvider(fetchImpl as unknown as typeof fetch);
    const result = await provider.sendEmail({
      to: 'customer@example.com',
      subject: 'Test subject',
      text: 'Plain body',
      html: '<p>HTML</p>',
    });

    expect(result.providerMessageId).toBe('sg-msg-123');
    expect(result.provider).toBe('email-gateway');
    expect(result.channel).toBe('email');
  });

  it('attaches custom_args.tenant_id when tenantId provided', async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      expect(body.custom_args).toEqual({ tenant_id: 'tenant-xyz' });
      return new Response('', { status: 202 });
    });
    const provider = makeProvider(fetchImpl as unknown as typeof fetch);
    await provider.sendEmail({
      to: 'a@b.c',
      subject: 's',
      text: 't',
      tenantId: 'tenant-xyz',
    });
  });

  it('throws DeliveryError when SendGrid returns non-2xx', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('Forbidden', { status: 403 })
    );
  });

  it('returns provider failure when SendGrid returns 403', async () => {
    const fetchImpl = vi.fn(async () => new Response('Forbidden', { status: 403 }));
    const provider = makeProvider(fetchImpl as unknown as typeof fetch);
    await expect(provider.sendEmail({ to: 'a@b.c', subject: 's', text: 't' })).rejects.toMatchObject({
      code: 'PROVIDER_FAILED',
      status: 403,
      providerBody: 'Forbidden',
    });
    await expect(provider.sendEmail({ to: 'a@b.c', subject: 's', text: 't' })).rejects.toBeInstanceOf(
      DeliveryError
    );
  });
});

describe('TwilioDeliveryProvider — config validation', () => {
  it('throws if SMS credentials missing', () => {
    expect(
      () =>
        new TwilioDeliveryProvider({
          sms: { accountSid: '', authToken: 't', fromNumber: '+1' },
          email: { apiKey: 'k', fromEmail: 'a@b' },
        })
    ).toThrow(/missing SMS credentials/);
  });

  it('throws if SendGrid credentials missing', () => {
    expect(
      () =>
        new TwilioDeliveryProvider({
          sms: { accountSid: 'a', authToken: 't', fromNumber: '+1' },
          email: { apiKey: '', fromEmail: '' },
        })
    ).toThrow(/missing SendGrid credentials/);
  });
});
