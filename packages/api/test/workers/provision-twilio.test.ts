import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Pool } from 'pg';
import {
  createProvisionTwilioWorker,
  PROVISION_TWILIO_JOB_TYPE,
  type ProvisionTwilioPayload,
} from '../../src/workers/provision-twilio';
import { createLogger } from '../../src/logging/logger';
import { QueueMessage } from '../../src/queues/queue';
import type { VapiClient } from '../../src/integrations/vapi/client';
import type { VapiAssistantConfig } from '../../src/integrations/vapi/assistant-config';

const TENANT = '11111111-1111-1111-1111-111111111111';
// 64-char hex = 32 bytes, the format TENANT_ENCRYPTION_KEY requires.
const KEY = 'a'.repeat(64);
const logger = createLogger({ service: 'test', environment: 'test', level: 'error' });

type MockResponse = { ok?: boolean; status?: number; body: unknown };

function mockFetch(...responses: MockResponse[]): ReturnType<typeof vi.fn> {
  const fn = vi.fn();
  for (const r of responses) {
    fn.mockResolvedValueOnce({
      ok: r.ok ?? true,
      status: r.status ?? 200,
      json: async () => r.body,
      text: async () => JSON.stringify(r.body),
    });
  }
  vi.stubGlobal('fetch', fn);
  return fn;
}

interface Call {
  sql: string;
  params: unknown[];
}

/**
 * Fake pool: tenantQuery runs every statement through pool.connect()→client.
 * The first status SELECT returns "fresh" (no row), the upsert returns a blank
 * row so the worker provisions from scratch, and every write is recorded so
 * tests can assert what was persisted.
 */
function makePool(
  opts: {
    selectRow?: Record<string, unknown>;
    failOnStatusFailed?: boolean;
    /** Row returned for the Step 4.5 `SELECT ... FROM tenant_settings`. */
    settingsRow?: Record<string, unknown>;
  } = {},
) {
  const calls: Call[] = [];
  const client = {
    query: vi.fn(async (sql: unknown, params: unknown[] = []) => {
      const s =
        typeof sql === 'string'
          ? sql
          : ((sql as { text?: string })?.text ?? String(sql));
      calls.push({ sql: s, params });
      if (opts.failOnStatusFailed && /status = 'failed'/i.test(s)) {
        throw new Error('db write failed');
      }
      if (/INSERT INTO tenant_integrations/i.test(s) && /RETURNING/i.test(s)) {
        return { rows: [{ subaccount_sid: null, auth_token_primary_enc: null, provider_data: {} }] };
      }
      if (/^\s*SELECT\s+status/i.test(s)) {
        return { rows: opts.selectRow ? [opts.selectRow] : [] };
      }
      // Step 4.5 reads the tenant's voice config to build the Vapi assistant.
      if (/^\s*SELECT\b[\s\S]*\bFROM tenant_settings\b/i.test(s)) {
        return { rows: opts.settingsRow ? [opts.settingsRow] : [] };
      }
      return { rows: [], rowCount: 1 };
    }),
    release: vi.fn(),
  };
  const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
  return { pool, calls };
}

/**
 * Mock Vapi client injected into the worker so Step 4.5 (assistant creation)
 * is exercised without real HTTP. Returns the spies so tests can assert the
 * agent was actually built + linked.
 */
function makeVapiMock(
  opts: { createAssistant?: () => Promise<{ assistantId: string }> } = {},
) {
  const impl = opts.createAssistant ?? (async () => ({ assistantId: 'asst_test_123' }));
  // Typed `_config` param so `.mock.calls[0][0]` is a VapiAssistantConfig.
  const createAssistant = vi.fn((_config: VapiAssistantConfig) => impl());
  const linkPhoneNumber = vi.fn(async () => ({ phoneNumberId: 'pn_test_1' }));
  const updateAssistant = vi.fn(async () => undefined);
  const client = { createAssistant, linkPhoneNumber, updateAssistant } as unknown as VapiClient;
  return { client, createAssistant, linkPhoneNumber, updateAssistant };
}

/** The five Twilio fetch responses for a full provision through "attach". */
function twilioHappyPath(): Parameters<typeof mockFetch> {
  return [
    { body: { sid: 'ACsub', auth_token: 'subtoken' } }, // create subaccount
    { body: { sid: 'MG123' } }, // messaging service
    { body: { incoming_phone_numbers: [] } }, // list owned (none yet)
    { body: { sid: 'PN555', phone_number: '+15125550123' } }, // purchase preferred
    { body: {} }, // attach to messaging service
  ];
}

function buildMessage(payload: ProvisionTwilioPayload): QueueMessage<ProvisionTwilioPayload> {
  return {
    id: 'msg-1',
    type: PROVISION_TWILIO_JOB_TYPE,
    payload,
    attempts: 1,
    maxAttempts: 3,
    idempotencyKey: `provision-twilio-${payload.tenantId}`,
    createdAt: new Date().toISOString(),
  };
}

describe('provision-twilio worker — number picker', () => {
  const restore: Array<[string, string | undefined]> = [];
  function setEnv(k: string, v: string | undefined): void {
    restore.push([k, process.env[k]]);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  afterEach(() => {
    vi.unstubAllGlobals();
    while (restore.length) {
      const [k, v] = restore.pop()!;
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  function configureTwilio(): void {
    setEnv('TWILIO_ACCOUNT_SID', 'ACmaster');
    setEnv('TWILIO_AUTH_TOKEN', 'mastertoken');
    setEnv('TENANT_ENCRYPTION_KEY', KEY);
    setEnv('VAPI_API_KEY', undefined); // keep the off-by-default Vapi step skipped
  }

  it('orders the claimed number and persists its E.164', async () => {
    configureTwilio();
    const fetchFn = mockFetch(
      { body: { sid: 'ACsub', auth_token: 'subtoken' } }, // create subaccount
      { body: { sid: 'MG123' } }, // messaging service
      { body: { incoming_phone_numbers: [] } }, // list owned (none yet)
      { body: { sid: 'PN555', phone_number: '+15125550123' } }, // purchase preferred
      { body: {} }, // attach to messaging service
    );

    const { pool, calls } = makePool();
    const worker = createProvisionTwilioWorker({ pool });

    await worker.handle(
      buildMessage({
        tenantId: TENANT,
        region: null,
        baseUrl: 'https://api.test',
        phoneNumber: '+15125550123',
      }),
      logger,
    );

    // The purchase POST carried the claimed number — not a search result.
    const purchaseCall = fetchFn.mock.calls.find(
      (c) =>
        String(c[0]).includes('/IncomingPhoneNumbers.json') &&
        (c[1] as RequestInit | undefined)?.method === 'POST',
    );
    expect(purchaseCall).toBeDefined();
    expect(String((purchaseCall![1] as RequestInit).body)).toContain('PhoneNumber=%2B15125550123');

    // provider_data was updated with the claimed E.164.
    const persisted = calls.find(
      (c) => /provider_data = provider_data/i.test(c.sql) && JSON.stringify(c.params).includes('+15125550123'),
    );
    expect(persisted).toBeDefined();
  });

  it('marks provisioning failed (no retry loop) when the claimed number is taken', async () => {
    configureTwilio();
    const fetchFn = mockFetch(
      { body: { sid: 'ACsub', auth_token: 'subtoken' } }, // create subaccount
      { body: { sid: 'MG123' } }, // messaging service
      { body: { incoming_phone_numbers: [] } }, // list owned (none)
      { ok: false, status: 400, body: { message: 'Number not available' } }, // purchase fails
    );

    const { pool, calls } = makePool();
    const worker = createProvisionTwilioWorker({ pool });

    // Must NOT throw: a thrown error would make the queue retry a number that
    // will never come back. The worker records a re-pickable failure instead.
    await expect(
      worker.handle(
        buildMessage({
          tenantId: TENANT,
          region: null,
          baseUrl: 'https://api.test',
          phoneNumber: '+15125550123',
        }),
        logger,
      ),
    ).resolves.toBeUndefined();

    const failedWrite = calls.find(
      (c) => /status = 'failed'/i.test(c.sql) && JSON.stringify(c.params).includes('no longer available'),
    );
    expect(failedWrite).toBeDefined();
    // It stopped before attaching: subaccount, messaging service, list, failed purchase.
    expect(fetchFn).toHaveBeenCalledTimes(4);
  });

  it('rethrows (so the queue retries) if it cannot even record the unavailable-number failure', async () => {
    configureTwilio();
    mockFetch(
      { body: { sid: 'ACsub', auth_token: 'subtoken' } }, // create subaccount
      { body: { sid: 'MG123' } }, // messaging service
      { body: { incoming_phone_numbers: [] } }, // list owned (none)
      { ok: false, status: 400, body: { message: 'Number not available' } }, // purchase fails (permanent)
    );

    // The 'failed' status write itself fails — the worker must NOT return
    // normally (which the queue would treat as success), stranding the tenant
    // at 't0_requested'. It must rethrow so the job retries.
    const { pool } = makePool({ failOnStatusFailed: true });
    const worker = createProvisionTwilioWorker({ pool });

    await expect(
      worker.handle(
        buildMessage({
          tenantId: TENANT,
          region: null,
          baseUrl: 'https://api.test',
          phoneNumber: '+15125550123',
        }),
        logger,
      ),
    ).rejects.toThrow();
  });

  it('rethrows a transient purchase error (5xx) so the queue retries — does NOT permanently fail a claimed number', async () => {
    configureTwilio();
    mockFetch(
      { body: { sid: 'ACsub', auth_token: 'subtoken' } }, // create subaccount
      { body: { sid: 'MG123' } }, // messaging service
      { body: { incoming_phone_numbers: [] } }, // list owned (none)
      { ok: false, status: 503, body: { message: 'service unavailable' } }, // transient purchase failure
    );

    const { pool, calls } = makePool();
    const worker = createProvisionTwilioWorker({ pool });

    // A transient error must propagate so the queue retries (the auto-pick
    // path already does this; the claimed-number path must not regress it).
    await expect(
      worker.handle(
        buildMessage({
          tenantId: TENANT,
          region: null,
          baseUrl: 'https://api.test',
          phoneNumber: '+15125550123',
        }),
        logger,
      ),
    ).rejects.toThrow();

    // It did NOT record the permanent "no longer available" re-pick failure.
    const permanentFail = calls.find(
      (c) => /status = 'failed'/i.test(c.sql) && JSON.stringify(c.params).includes('no longer available'),
    );
    expect(permanentFail).toBeUndefined();
  });

  it('is idempotent: skips entirely when the tenant is already fully provisioned', async () => {
    configureTwilio();
    const fetchFn = mockFetch(); // any Twilio call would be an error

    const { pool } = makePool({
      selectRow: {
        status: 'full_readiness',
        subaccount_sid: 'ACexisting',
        auth_token_primary_enc: null,
        provider_data: { phoneE164: '+15125550999' },
      },
    });
    const worker = createProvisionTwilioWorker({ pool });

    await worker.handle(
      buildMessage({ tenantId: TENANT, region: null, baseUrl: 'https://api.test', phoneNumber: '+15125550123' }),
      logger,
    );

    // The early-return guard fired: no subaccount created, no number bought.
    expect(fetchFn).not.toHaveBeenCalled();
  });

  // ─── Step 4.5: Vapi assistant (the voice agent) creation ──────────────────

  it('creates the Vapi assistant, links the number, and persists vapi_assistant_id', async () => {
    configureTwilio();
    mockFetch(...twilioHappyPath());

    const { pool, calls } = makePool({
      settingsRow: {
        business_name: "Bob's Plumbing",
        voice_greeting: null,
        voice_id: 'adam',
        services_offered: ['drain cleaning', 'water heaters'],
        vapi_assistant_id: null,
      },
    });
    const vapi = makeVapiMock();
    const worker = createProvisionTwilioWorker({ pool, vapiClient: vapi.client });

    await worker.handle(
      buildMessage({ tenantId: TENANT, region: null, baseUrl: 'https://api.test', phoneNumber: '+15125550123' }),
      logger,
    );

    // The assistant is built from the tenant's voice config: 'adam' preset →
    // its ElevenLabs id, business name in the assistant name, and the greeting
    // auto-generated from the services offered.
    expect(vapi.createAssistant).toHaveBeenCalledTimes(1);
    const cfg = vapi.createAssistant.mock.calls[0][0];
    expect(cfg.name).toContain("Bob's Plumbing");
    expect(cfg.voiceId).toBe('pNInz6obpgDQGcFmaJgB'); // adam → ElevenLabs voice id
    expect(cfg.firstMessage).toContain('We handle drain cleaning and water heaters');
    expect(cfg.serverUrl).toBe(`https://api.test/webhooks/vapi/${TENANT}`);

    // The freshly created assistant is linked to the provisioned number.
    expect(vapi.linkPhoneNumber).toHaveBeenCalledWith(
      expect.objectContaining({
        assistantId: 'asst_test_123',
        phoneE164: '+15125550123',
        twilioPhoneNumberSid: 'PN555',
      }),
    );

    // The assistant id is written back to the tenant so the next run is idempotent,
    // alongside the per-tenant vapi_webhook_secret.
    const settingsWrite = calls.find(
      (c) =>
        /UPDATE tenant_settings\s+SET vapi_assistant_id/i.test(c.sql) &&
        /vapi_webhook_secret/i.test(c.sql) &&
        JSON.stringify(c.params).includes('asst_test_123'),
    );
    expect(settingsWrite).toBeDefined();
    // A random 32-byte hex per-tenant secret is persisted (never the global one).
    expect(
      (settingsWrite!.params as unknown[]).some(
        (p) => typeof p === 'string' && /^[0-9a-f]{64}$/.test(p),
      ),
    ).toBe(true);

    // …and mirrored onto the integration row's provider_data.
    const integrationWrite = calls.find(
      (c) =>
        /UPDATE tenant_integrations/i.test(c.sql) &&
        JSON.stringify(c.params).includes('vapiAssistantId') &&
        JSON.stringify(c.params).includes('asst_test_123'),
    );
    expect(integrationWrite).toBeDefined();
  });

  it('skips assistant creation when the tenant already has a vapi_assistant_id', async () => {
    configureTwilio();
    mockFetch(...twilioHappyPath());

    const { pool } = makePool({
      settingsRow: {
        business_name: "Bob's Plumbing",
        voice_greeting: null,
        voice_id: 'adam',
        services_offered: [],
        vapi_assistant_id: 'asst_already_there',
      },
    });
    const vapi = makeVapiMock();
    const worker = createProvisionTwilioWorker({ pool, vapiClient: vapi.client });

    await worker.handle(
      buildMessage({ tenantId: TENANT, region: null, baseUrl: 'https://api.test', phoneNumber: '+15125550123' }),
      logger,
    );

    // Idempotent: an existing assistant is neither recreated nor re-linked.
    expect(vapi.createAssistant).not.toHaveBeenCalled();
    expect(vapi.linkPhoneNumber).not.toHaveBeenCalled();
  });

  // ─── Dev/test stub: no Twilio creds ───────────────────────────────────────

  it('writes a stub full_readiness integration in non-production when Twilio creds are absent (so onboarding completes)', async () => {
    setEnv('NODE_ENV', 'development');
    setEnv('TWILIO_ACCOUNT_SID', undefined);
    setEnv('TWILIO_AUTH_TOKEN', undefined);
    // Any Twilio HTTP call here would be a bug — the stub path must not touch Twilio.
    const fetchFn = mockFetch();

    const { pool, calls } = makePool();
    const worker = createProvisionTwilioWorker({ pool });

    await worker.handle(
      buildMessage({ tenantId: TENANT, region: null, baseUrl: 'https://api.test' }),
      logger,
    );

    expect(fetchFn).not.toHaveBeenCalled();

    // A tenant_integrations row was written as 'full_readiness' with the fake
    // stub number, so deriveOnboardingStatus marks the phone step done.
    const stubWrite = calls.find(
      (c) =>
        /INSERT INTO tenant_integrations/i.test(c.sql) &&
        JSON.stringify(c.params).includes('full_readiness') &&
        JSON.stringify(c.params).includes('+15005550006'),
    );
    expect(stubWrite).toBeDefined();
  });

  it('does NOT fabricate a stub in production — still requires real Twilio creds', async () => {
    setEnv('NODE_ENV', 'production');
    setEnv('TWILIO_ACCOUNT_SID', undefined);
    setEnv('TWILIO_AUTH_TOKEN', undefined);

    const { pool, calls } = makePool();
    const worker = createProvisionTwilioWorker({ pool });

    await expect(
      worker.handle(
        buildMessage({ tenantId: TENANT, region: null, baseUrl: 'https://api.test' }),
        logger,
      ),
    ).rejects.toThrow(/TWILIO_ACCOUNT_SID/);

    // No stub number was ever persisted in production.
    const anyStub = calls.find((c) => JSON.stringify(c.params).includes('+15005550006'));
    expect(anyStub).toBeUndefined();
  });

  it('does not fail Twilio provisioning when Vapi assistant creation throws (best-effort)', async () => {
    configureTwilio();
    mockFetch(...twilioHappyPath());

    const { pool, calls } = makePool({
      settingsRow: {
        business_name: "Bob's Plumbing",
        voice_greeting: null,
        voice_id: 'adam',
        services_offered: [],
        vapi_assistant_id: null,
      },
    });
    const vapi = makeVapiMock({
      createAssistant: async () => {
        throw new Error('vapi 500');
      },
    });
    const worker = createProvisionTwilioWorker({ pool, vapiClient: vapi.client });

    // A Vapi hiccup must NOT throw — SMS/voice readiness is unaffected.
    await expect(
      worker.handle(
        buildMessage({ tenantId: TENANT, region: null, baseUrl: 'https://api.test', phoneNumber: '+15125550123' }),
        logger,
      ),
    ).resolves.toBeUndefined();

    expect(vapi.createAssistant).toHaveBeenCalledTimes(1);
    // Provisioning still reached the active state despite the Vapi failure.
    const activeWrite = calls.find(
      (c) =>
        /provisioned_at = NOW\(\)/i.test(c.sql) &&
        JSON.stringify(c.params).includes('full_readiness'),
    );
    expect(activeWrite).toBeDefined();
  });
});
