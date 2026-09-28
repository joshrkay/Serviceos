import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Pool } from 'pg';
import {
  createReleaseTwilioNumberWorker,
  RELEASE_TWILIO_NUMBER_JOB_TYPE,
  type ReleaseTwilioNumberPayload,
} from '../../src/workers/release-twilio-number';
import { createLogger } from '../../src/logging/logger';
import { encrypt } from '../../src/integrations/crypto';
import { QueueMessage } from '../../src/queues/queue';

const TENANT = '11111111-1111-1111-1111-111111111111';
const KEY = 'a'.repeat(64);
const logger = createLogger({ service: 'test', environment: 'test', level: 'error' });

function setEnv(key: string, value: string | undefined): string | undefined {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  return prev;
}

interface Call {
  sql: string;
  params: unknown[];
}

/**
 * Fake pool: tenantQuery runs every statement through pool.connect()→client.
 * The integration SELECT returns the configured row; writes are recorded.
 */
function makePool(integrationRow: Record<string, unknown> | null) {
  const calls: Call[] = [];
  const client = {
    query: vi.fn(async (sql: unknown, params: unknown[] = []) => {
      const s =
        typeof sql === 'string'
          ? sql
          : ((sql as { text?: string })?.text ?? String(sql));
      calls.push({ sql: s, params });
      if (/FROM tenant_integrations/i.test(s)) {
        return { rows: integrationRow ? [integrationRow] : [] };
      }
      return { rows: [], rowCount: 1 };
    }),
    release: vi.fn(),
  };
  const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
  return { pool, calls };
}

function buildMessage(payload: ReleaseTwilioNumberPayload): QueueMessage<ReleaseTwilioNumberPayload> {
  return {
    id: 'msg-1',
    type: RELEASE_TWILIO_NUMBER_JOB_TYPE,
    payload,
    attempts: 1,
    maxAttempts: 3,
    idempotencyKey: `release-twilio-${payload.tenantId}`,
    createdAt: new Date().toISOString(),
  };
}

function provisionedRow(): Record<string, unknown> {
  return {
    subaccount_sid: 'ACsub',
    auth_token_primary_enc: encrypt('subtoken', KEY),
    provider_data: {
      phoneNumberSid: 'PN555',
      phoneE164: '+15125550123',
      numberAttached: true,
      messagingServiceSid: 'MG123',
    },
  };
}

describe('release-twilio-number worker', () => {
  const restore: Array<[string, string | undefined]> = [];
  afterEach(() => {
    vi.unstubAllGlobals();
    while (restore.length) {
      const [k, v] = restore.pop()!;
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  function configureTwilio(): void {
    restore.push(['TWILIO_ACCOUNT_SID', setEnv('TWILIO_ACCOUNT_SID', 'ACmaster')]);
    restore.push(['TWILIO_AUTH_TOKEN', setEnv('TWILIO_AUTH_TOKEN', 'mastertoken')]);
    restore.push(['TENANT_ENCRYPTION_KEY', setEnv('TENANT_ENCRYPTION_KEY', KEY)]);
  }

  it('releases the number and clears the phone fields (keeps subaccount)', async () => {
    configureTwilio();
    const fetchFn: ReturnType<typeof vi.fn> = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' }));
    vi.stubGlobal('fetch', fetchFn);

    const { pool, calls } = makePool(provisionedRow());
    const worker = createReleaseTwilioNumberWorker({ pool });
    await worker.handle(
      buildMessage({ tenantId: TENANT, reason: 'stripe_subscription_canceled' }),
      logger,
    );

    // DELETE against the number SID on the subaccount.
    const del = fetchFn.mock.calls.find(
      (c) => (c[1] as RequestInit | undefined)?.method === 'DELETE',
    );
    expect(del).toBeDefined();
    expect(String(del![0])).toContain('/Accounts/ACsub/IncomingPhoneNumbers/PN555.json');

    // Phone fields cleared; subaccount + messaging service retained; status
    // reset so a resubscribe re-provisions.
    const update = calls.find((c) => /UPDATE tenant_integrations/i.test(c.sql));
    expect(update).toBeDefined();
    expect(update!.sql).toContain(`provider_data - 'phoneNumberSid' - 'phoneE164' - 'numberAttached'`);
    expect(update!.sql).toContain(`status = 't0_requested'`);
    expect(update!.sql).not.toContain('subaccount_sid');
  });

  it('is a no-op when no number is provisioned (idempotent)', async () => {
    configureTwilio();
    const fetchFn: ReturnType<typeof vi.fn> = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' }));
    vi.stubGlobal('fetch', fetchFn);

    // Already released: row exists but the phone fields are gone.
    const { pool, calls } = makePool({
      subaccount_sid: 'ACsub',
      auth_token_primary_enc: encrypt('subtoken', KEY),
      provider_data: { messagingServiceSid: 'MG123' },
    });
    const worker = createReleaseTwilioNumberWorker({ pool });
    await worker.handle(
      buildMessage({ tenantId: TENANT, reason: 'stripe_subscription_deleted' }),
      logger,
    );

    expect(fetchFn).not.toHaveBeenCalled();
    expect(calls.some((c) => /UPDATE tenant_integrations/i.test(c.sql))).toBe(false);
  });

  it('is a no-op when there is no integration row at all', async () => {
    configureTwilio();
    const fetchFn: ReturnType<typeof vi.fn> = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' }));
    vi.stubGlobal('fetch', fetchFn);

    const { pool } = makePool(null);
    const worker = createReleaseTwilioNumberWorker({ pool });
    await expect(
      worker.handle(
        buildMessage({ tenantId: TENANT, reason: 'stripe_subscription_deleted' }),
        logger,
      ),
    ).resolves.toBeUndefined();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('skips the dev stub number (never a real line)', async () => {
    configureTwilio();
    const fetchFn: ReturnType<typeof vi.fn> = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' }));
    vi.stubGlobal('fetch', fetchFn);

    const { pool } = makePool({
      subaccount_sid: null,
      auth_token_primary_enc: null,
      provider_data: { phoneE164: '+15005550006', stub: true },
    });
    const worker = createReleaseTwilioNumberWorker({ pool });
    await worker.handle(
      buildMessage({ tenantId: TENANT, reason: 'stripe_subscription_canceled' }),
      logger,
    );
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('treats an already-released number (Twilio 404) as success', async () => {
    configureTwilio();
    const fetchFn: ReturnType<typeof vi.fn> = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => 'not found' }));
    vi.stubGlobal('fetch', fetchFn);

    const { pool, calls } = makePool(provisionedRow());
    const worker = createReleaseTwilioNumberWorker({ pool });
    await expect(
      worker.handle(
        buildMessage({ tenantId: TENANT, reason: 'stripe_subscription_canceled' }),
        logger,
      ),
    ).resolves.toBeUndefined();
    // Still clears the local state — the number is gone either way.
    expect(calls.some((c) => /UPDATE tenant_integrations/i.test(c.sql))).toBe(true);
  });

  it('does not throw when Twilio fails (failure-tolerant)', async () => {
    configureTwilio();
    const fetchFn: ReturnType<typeof vi.fn> = vi.fn(async () => {
      throw new Error('twilio 500');
    });
    vi.stubGlobal('fetch', fetchFn);

    const { pool } = makePool(provisionedRow());
    const worker = createReleaseTwilioNumberWorker({ pool });
    await expect(
      worker.handle(
        buildMessage({ tenantId: TENANT, reason: 'stripe_subscription_canceled' }),
        logger,
      ),
    ).resolves.toBeUndefined();
  });
});
