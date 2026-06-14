import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Pool } from 'pg';
import {
  createProvisionTwilioWorker,
  PROVISION_TWILIO_JOB_TYPE,
  type ProvisionTwilioPayload,
} from '../../src/workers/provision-twilio';
import { createLogger } from '../../src/logging/logger';
import { QueueMessage } from '../../src/queues/queue';

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
function makePool() {
  const calls: Call[] = [];
  const client = {
    query: vi.fn(async (sql: unknown, params: unknown[] = []) => {
      const s =
        typeof sql === 'string'
          ? sql
          : ((sql as { text?: string })?.text ?? String(sql));
      calls.push({ sql: s, params });
      if (/INSERT INTO tenant_integrations/i.test(s) && /RETURNING/i.test(s)) {
        return { rows: [{ subaccount_sid: null, auth_token_primary_enc: null, provider_data: {} }] };
      }
      if (/^\s*SELECT\s+status/i.test(s)) {
        return { rows: [] };
      }
      return { rows: [], rowCount: 1 };
    }),
    release: vi.fn(),
  };
  const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
  return { pool, calls };
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
});
