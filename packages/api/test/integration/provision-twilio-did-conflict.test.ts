/**
 * Docker-gated integration test for #1061 (c) — the provisioning path must
 * surface a DID already claimed by another tenant as a clean, actionable
 * failure, not as a raw Postgres error.
 *
 * With migration 274's `uq_tenant_integrations_twilio_phone_e164` in force,
 * the `provider_data || {phoneNumberSid, phoneE164}` write in
 * workers/provision-twilio.ts raises 23505 when a second tenant is provisioned
 * onto a number a first tenant already holds. Left unhandled that becomes:
 *
 *   status    = 'failed'
 *   last_error = 'duplicate key value violates unique constraint
 *                 "uq_tenant_integrations_twilio_phone_e164"'
 *
 * …and the job rethrows, so the queue retries it — forever, because the DID
 * will never free itself. Both halves are wrong: an operator cannot act on
 * that text, and the retry is pure noise.
 *
 * Expected instead, mirroring the existing unavailable-preferred-number and
 * magic-test-number branches in the same handler: an operator-actionable
 * `last_error`, and a clean return (no throw → no retry).
 *
 * Twilio HTTP is stubbed; only the DB is real.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { closeSharedTestDb, createTestTenant, getSharedTestDb } from './shared';
import {
  createProvisionTwilioWorker,
  isDidAlreadyClaimed,
  PROVISION_TWILIO_JOB_TYPE,
  type ProvisionTwilioPayload,
} from '../../src/workers/provision-twilio';
import { createLogger } from '../../src/logging/logger';
import { QueueMessage } from '../../src/queues/queue';

const KEY = 'a'.repeat(64);
const logger = createLogger({ service: 'test', environment: 'test', level: 'error' });

/**
 * The DID the first tenant already owns and the second one is pushed onto.
 *
 * Distinct from every other integration file's number on purpose: migration
 * 274 makes a DID unique ACROSS tenants, and the integration suite shares one
 * database, so two files reusing a literal now collide.
 */
const CONTESTED_DID = '+15125559901';

function buildMessage(payload: ProvisionTwilioPayload): QueueMessage<ProvisionTwilioPayload> {
  return {
    id: 'msg-did-conflict-1',
    type: PROVISION_TWILIO_JOB_TYPE,
    payload,
    attempts: 1,
    maxAttempts: 3,
    idempotencyKey: `provision-twilio-${payload.tenantId}`,
    createdAt: new Date().toISOString(),
  };
}

type FetchCall = [string, { method?: string } | undefined];

/**
 * A small STATEFUL fake of the Twilio subaccount, not an ordered queue of
 * canned bodies.
 *
 * That distinction is the point of the orphan tests below. The recovery path
 * calls `listSubaccountPhoneNumbers()` and uses whatever the subaccount still
 * owns; a canned "empty list" would assert the fix into existence regardless
 * of whether the release actually happened. Here `purchase` adds to `owned`
 * and the release DELETE removes from it, so "the re-run reaches a different
 * number" can only pass if the number was genuinely handed back.
 *
 * Survives across `worker.handle()` calls, which is what makes a second run
 * meaningful. `releaseFails` makes every DELETE answer 500.
 */
function stubTwilioAccount(
  purchases: Array<{ sid: string; phone_number: string }>,
  opts: { releaseFails?: boolean } = {},
) {
  const owned = new Map<string, string>();
  let nextPurchase = 0;
  const ok = (body: unknown) => ({
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });

  const fn = vi.fn(async (url: string, init?: { method?: string }) => {
    const method = init?.method ?? 'GET';

    if (method === 'DELETE') {
      if (opts.releaseFails) {
        return { ok: false, status: 500, json: async () => ({}), text: async () => 'twilio is down' };
      }
      const sid = url.match(/IncomingPhoneNumbers\/(\w+)\.json/)?.[1];
      if (sid) owned.delete(sid);
      return ok({});
    }
    if (url.endsWith('/Accounts.json')) return ok({ sid: 'ACsub', auth_token: 'subtoken' });
    if (url.includes('messaging.twilio.com') && url.endsWith('/Services')) return ok({});
    if (url.endsWith('/Services.json')) return ok({ sid: 'MG123' });
    if (url.includes('IncomingPhoneNumbers.json')) {
      if (method === 'POST') {
        const p = purchases[nextPurchase++];
        owned.set(p.sid, p.phone_number);
        return ok(p);
      }
      return ok({
        incoming_phone_numbers: [...owned].map(([sid, phone_number]) => ({ sid, phone_number })),
      });
    }
    return ok({});
  });

  vi.stubGlobal('fetch', fn);
  return { fn: fn as unknown as ReturnType<typeof vi.fn>, owned };
}

function deleteCalls(fn: ReturnType<typeof vi.fn>): FetchCall[] {
  return (fn.mock.calls as FetchCall[]).filter(([, init]) => init?.method === 'DELETE');
}

async function seedSettings(pool: Pool, tenantId: string): Promise<void> {
  await pool.query(
    `INSERT INTO tenant_settings (id, tenant_id, business_name, voice_greeting, voice_id, services_offered)
       VALUES (gen_random_uuid(), $1, $2, NULL, 'adam', $3::text[])`,
    [tenantId, "Bob's Plumbing", ['drain cleaning']],
  );
}

/** Give `tenantId` the DID outright, as a completed provision would have. */
async function seedIncumbent(pool: Pool, tenantId: string, phoneE164: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL app.current_tenant_id = '${tenantId}'`);
    await client.query(
      `INSERT INTO tenant_integrations (tenant_id, provider, status, provider_data)
       VALUES ($1, 'twilio', 'full_readiness', $2::jsonb)`,
      [tenantId, JSON.stringify({ phoneE164, phoneNumberSid: 'PNincumbent' })],
    );
    await client.query('COMMIT');
  } finally {
    try {
      await client.query('RESET app.current_tenant_id');
    } catch {
      /* best effort */
    }
    client.release();
  }
}

describe('Postgres integration — provisioning onto a DID another tenant holds (#1061)', () => {
  let pool: Pool;
  const restore: Array<[string, string | undefined]> = [];

  function setEnv(k: string, v: string | undefined): void {
    restore.push([k, process.env[k]]);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }

  beforeAll(async () => {
    pool = await getSharedTestDb();
  });
  afterAll(async () => {
    await closeSharedTestDb();
  });

  beforeEach(() => {
    setEnv('TWILIO_ACCOUNT_SID', 'ACmaster');
    setEnv('TWILIO_AUTH_TOKEN', 'mastertoken');
    setEnv('TENANT_ENCRYPTION_KEY', KEY);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    while (restore.length) {
      const [k, v] = restore.pop()!;
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('records an operator-actionable failure and does not retry', async () => {
    const incumbent = await createTestTenant(pool);
    await seedIncumbent(pool, incumbent.tenantId, CONTESTED_DID);

    const challenger = await createTestTenant(pool);
    await seedSettings(pool, challenger.tenantId);
    stubTwilioAccount([{ sid: 'PN555', phone_number: CONTESTED_DID }]);

    const worker = createProvisionTwilioWorker({ pool });

    // Clean return, not a throw: the queue must not retry a conflict that
    // cannot resolve itself.
    await expect(
      worker.handle(
        buildMessage({
          tenantId: challenger.tenantId,
          region: null,
          baseUrl: 'https://api.test',
          phoneNumber: CONTESTED_DID,
        }),
        logger,
      ),
    ).resolves.toBeUndefined();

    const { rows } = await pool.query<{ status: string; last_error: string | null }>(
      `SELECT status, last_error FROM tenant_integrations
        WHERE tenant_id = $1 AND provider = 'twilio'`,
      [challenger.tenantId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('failed');

    const err = rows[0].last_error ?? '';
    // Actionable: names the number, the cause, and the two ways out.
    expect(err).toContain(CONTESTED_DID);
    expect(err).toContain('already assigned to another tenant');
    expect(err).toContain('re-run provisioning');
    // Never the raw Postgres text.
    expect(err).not.toContain('duplicate key value');
    expect(err).not.toContain('uq_tenant_integrations_twilio_phone_e164');
  });

  it('leaves the incumbent tenant untouched — it keeps the DID', async () => {
    const { rows } = await pool.query<{ tenant_id: string; status: string }>(
      `SELECT tenant_id, status FROM tenant_integrations
        WHERE provider = 'twilio' AND provider_data->>'phoneE164' = $1`,
      [CONTESTED_DID],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('full_readiness');
  });

  /**
   * xhawk-ai review on PR #1120 (Medium/correctness), confirmed against the
   * code: the conflict is detected AFTER the number has been purchased into
   * the challenger's subaccount, and the UPDATE that would have persisted
   * `phoneNumberSid` is the very one that failed. So nothing records the
   * purchase — and the next run takes the `!phoneNumberSid` branch,
   * `listSubaccountPhoneNumbers()` hands the orphan straight back, and the
   * same conflict repeats while the tenant keeps paying for it.
   *
   * That makes the operator message ("provision this tenant on a different
   * number, then re-run provisioning") a promise the code could not keep.
   */
  it('releases the number it just bought, so the tenant stops paying for an orphan', async () => {
    const incumbent = await createTestTenant(pool);
    await seedIncumbent(pool, incumbent.tenantId, '+15125559905');

    const challenger = await createTestTenant(pool);
    await seedSettings(pool, challenger.tenantId);
    const { fn: fetchMock, owned } = stubTwilioAccount([
      { sid: 'PN555', phone_number: '+15125559905' },
    ]);

    await createProvisionTwilioWorker({ pool }).handle(
      buildMessage({
        tenantId: challenger.tenantId,
        region: null,
        baseUrl: 'https://api.test',
        phoneNumber: '+15125559905',
      }),
      logger,
    );

    const deletes = deleteCalls(fetchMock);
    expect(deletes).toHaveLength(1);
    expect(deletes[0][0]).toContain('/Accounts/ACsub/IncomingPhoneNumbers/PN555.json');
    // …and the subaccount really no longer holds it.
    expect([...owned.keys()]).toEqual([]);

    const { rows } = await pool.query<{ last_error: string | null }>(
      `SELECT last_error FROM tenant_integrations WHERE tenant_id = $1 AND provider = 'twilio'`,
      [challenger.tenantId],
    );
    expect(rows[0].last_error).toContain('released');
  });

  it('a re-run then reaches a different number instead of recovering the orphan', async () => {
    const incumbent = await createTestTenant(pool);
    await seedIncumbent(pool, incumbent.tenantId, '+15125559906');

    const challenger = await createTestTenant(pool);
    await seedSettings(pool, challenger.tenantId);
    // ONE stateful account across both runs: run 2's list reflects whatever
    // run 1 left behind, so this cannot pass unless the orphan was released.
    stubTwilioAccount([
      { sid: 'PN555', phone_number: '+15125559906' },
      { sid: 'PN556', phone_number: '+15125559907' },
    ]);
    const worker = createProvisionTwilioWorker({ pool });
    const msg = (phoneNumber: string) =>
      buildMessage({ tenantId: challenger.tenantId, region: null, baseUrl: 'https://api.test', phoneNumber });

    await worker.handle(msg('+15125559906'), logger);

    await worker.handle(msg('+15125559907'), logger);

    const { rows } = await pool.query<{
      status: string;
      provider_data: { phoneE164?: string };
    }>(
      `SELECT status, provider_data FROM tenant_integrations WHERE tenant_id = $1 AND provider = 'twilio'`,
      [challenger.tenantId],
    );
    expect(rows[0].provider_data.phoneE164).toBe('+15125559907');
    expect(rows[0].status).toBe('full_readiness');
  });

  it('when the release itself fails, it says so and throws so the cleanup is retried', async () => {
    const incumbent = await createTestTenant(pool);
    await seedIncumbent(pool, incumbent.tenantId, '+15125559908');

    const challenger = await createTestTenant(pool);
    await seedSettings(pool, challenger.tenantId);
    stubTwilioAccount([{ sid: 'PN555', phone_number: '+15125559908' }], { releaseFails: true });

    await expect(
      createProvisionTwilioWorker({ pool }).handle(
        buildMessage({
          tenantId: challenger.tenantId,
          region: null,
          baseUrl: 'https://api.test',
          phoneNumber: '+15125559908',
        }),
        logger,
      ),
    ).rejects.toThrow(/release/i);

    const { rows } = await pool.query<{ status: string; last_error: string | null }>(
      `SELECT status, last_error FROM tenant_integrations WHERE tenant_id = $1 AND provider = 'twilio'`,
      [challenger.tenantId],
    );
    expect(rows[0].status).toBe('failed');
    // Names the SID an operator has to release by hand.
    expect(rows[0].last_error).toContain('PN555');
  });

  it('isDidAlreadyClaimed distinguishes the DID index from the tenant/provider unique', () => {
    expect(
      isDidAlreadyClaimed({ code: '23505', constraint: 'uq_tenant_integrations_twilio_phone_e164' }),
    ).toBe(true);
    // 070's UNIQUE (tenant_id, provider) raises the same SQLSTATE for a
    // different, retryable reason — the code alone would misclassify it.
    expect(
      isDidAlreadyClaimed({ code: '23505', constraint: 'tenant_integrations_tenant_id_provider_key' }),
    ).toBe(false);
    expect(isDidAlreadyClaimed({ code: '23503' })).toBe(false);
    expect(isDidAlreadyClaimed(new Error('boom'))).toBe(false);
    expect(isDidAlreadyClaimed(null)).toBe(false);
  });
});
