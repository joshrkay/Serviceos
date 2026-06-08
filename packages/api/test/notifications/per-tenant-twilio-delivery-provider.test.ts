/**
 * Feature 7 — Per-tenant outbound notification SMS (launch-readiness pass).
 *
 * Verifies the per-tenant SMS provider resolves each tenant's own Twilio
 * subaccount credentials (over a tenant-scoped transaction so RLS lets the
 * read through), fails closed when a tenant has no usable credentials, and
 * delegates email + tenantless SMS to the base provider.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { PerTenantTwilioDeliveryProvider } from '../../src/notifications/per-tenant-twilio-delivery-provider';
import { DeliveryError } from '../../src/notifications/notification-errors';
import {
  MessageDeliveryProvider,
  SmsMessage,
} from '../../src/notifications/delivery-provider';
import { flushCredentialCache } from '../../src/integrations/credentials';
import { encrypt } from '../../src/integrations/crypto';

const KEY = '0'.repeat(64); // 32-byte hex key for AES-256-GCM
const TENANT_A = uuidv4();
const TENANT_B = uuidv4();

// A fake pg Pool. getTenantTwilioCreds resolves creds over a tenant-scoped
// transaction (connect -> BEGIN -> set_config -> SELECT tenant_integrations ->
// COMMIT), so the client returns rows only for the tenant_integrations SELECT.
function fakePool(rowsByTenant: Record<string, Record<string, unknown>[]>) {
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      if (typeof sql === 'string' && sql.includes('tenant_integrations')) {
        const tenantId = params?.[0] as string;
        return { rows: rowsByTenant[tenantId] ?? [] };
      }
      return { rows: [] }; // BEGIN / set_config / COMMIT
    }),
    release: vi.fn(),
  };
  return { connect: vi.fn(async () => client), query: client.query } as any;
}

interface CapturedRequest { url: string; body: string; auth: string }

function capturingFetch(sid: string, captured: CapturedRequest[]) {
  return vi.fn(async (url: string, init: any) => {
    captured.push({
      url,
      body: String(init.body),
      auth: String(init.headers.Authorization),
    });
    return {
      ok: true, status: 200,
      json: async () => ({ sid, status: 'queued' }),
      text: async () => '',
    };
  }) as unknown as typeof fetch;
}

let baseProvider: MessageDeliveryProvider;

const msg = (over: Partial<SmsMessage> = {}): SmsMessage => ({
  to: '+15551230000', body: 'Your appointment is confirmed.', tenantId: TENANT_A, ...over,
});

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

describe('Feature 7 — Per-tenant notification SMS', () => {
  beforeEach(() => {
    baseProvider = {
      sendSms: vi.fn(async () => ({ providerMessageId: 'base-sms', provider: 'base', channel: 'sms' as const })),
      sendEmail: vi.fn(async () => ({ providerMessageId: 'base-email', provider: 'base', channel: 'email' as const })),
    };
    flushCredentialCache(TENANT_A);
    flushCredentialCache(TENANT_B);
    process.env.TENANT_ENCRYPTION_KEY = KEY;
  });

  afterEach(() => {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  });

  it("sends via the tenant's own subaccount + messaging service", async () => {
    const captured: CapturedRequest[] = [];
    const provider = new PerTenantTwilioDeliveryProvider({
      pool: fakePool({
        [TENANT_A]: [{
          subaccount_sid: 'AC_tenantA',
          auth_token_primary_enc: encrypt('tok_tenantA', KEY),
          credential_version: 1,
          status: 'full_readiness',
          provider_data: { messagingServiceSid: 'MG_tenantA' },
        }],
      }),
      base: baseProvider,
      fetchImpl: capturingFetch('SM_tenantA', captured),
    });

    const res = await provider.sendSms(msg());

    expect(res.providerMessageId).toBe('SM_tenantA');
    expect(captured).toHaveLength(1);
    expect(captured[0].url).toContain('/Accounts/AC_tenantA/Messages.json');
    expect(captured[0].body).toContain('MessagingServiceSid=MG_tenantA');
    expect(captured[0].auth).toBe(
      'Basic ' + Buffer.from('AC_tenantA:tok_tenantA').toString('base64'),
    );
    expect(baseProvider.sendSms).not.toHaveBeenCalled();
  });

  it('fails closed (DeliveryError) when the tenant has no integration row', async () => {
    process.env.NODE_ENV = 'production'; // prod resolver throws on missing row
    const fetchImpl = capturingFetch('SM_should_not_send', []);
    const provider = new PerTenantTwilioDeliveryProvider({
      pool: fakePool({}), // no rows for any tenant
      base: baseProvider,
      fetchImpl,
    });

    await expect(provider.sendSms(msg({ tenantId: TENANT_B }))).rejects.toMatchObject({
      name: 'DeliveryError',
      code: 'AUTH_FAILED',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(baseProvider.sendSms).not.toHaveBeenCalled();
  });

  it('fails closed (DeliveryError) for a malformed tenant id without touching the DB', async () => {
    const pool = fakePool({});
    const provider = new PerTenantTwilioDeliveryProvider({
      pool, base: baseProvider, fetchImpl: capturingFetch('SM_unused', []),
    });
    await expect(provider.sendSms(msg({ tenantId: 'not-a-uuid' }))).rejects.toMatchObject({
      name: 'DeliveryError', code: 'AUTH_FAILED',
    });
    expect(pool.connect).not.toHaveBeenCalled(); // no connection acquired for junk input
  });

  it('delegates tenantless SMS to the base (global) provider', async () => {
    const provider = new PerTenantTwilioDeliveryProvider({
      pool: fakePool({}),
      base: baseProvider,
      fetchImpl: capturingFetch('SM_unused', []),
    });
    const res = await provider.sendSms(msg({ tenantId: undefined }));
    expect(res.providerMessageId).toBe('base-sms');
    expect(baseProvider.sendSms).toHaveBeenCalledTimes(1);
  });

  it('delegates email to the base (global) provider', async () => {
    const provider = new PerTenantTwilioDeliveryProvider({
      pool: fakePool({}),
      base: baseProvider,
      fetchImpl: capturingFetch('SM_unused', []),
    });
    const res = await provider.sendEmail({ to: 'x@y.com', subject: 'Hi', text: 'body', tenantId: TENANT_A });
    expect(res.providerMessageId).toBe('base-email');
    expect(baseProvider.sendEmail).toHaveBeenCalledTimes(1);
  });

  it('throws DeliveryError on a Twilio error response (does not crash)', async () => {
    const provider = new PerTenantTwilioDeliveryProvider({
      pool: fakePool({
        [TENANT_A]: [{
          subaccount_sid: 'AC_tenantA',
          auth_token_primary_enc: encrypt('tok_tenantA', KEY),
          credential_version: 2,
          status: 'full_readiness',
          provider_data: { phoneE164: '+15557654321' },
        }],
      }),
      base: baseProvider,
      fetchImpl: vi.fn(async () => ({
        ok: false, status: 401, json: async () => ({}), text: async () => 'unauthorized',
      })) as unknown as typeof fetch,
    });

    await expect(provider.sendSms(msg())).rejects.toMatchObject({
      name: 'DeliveryError',
      code: 'AUTH_FAILED',
      status: 401,
    });
  });
});
