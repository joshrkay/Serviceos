/**
 * Postgres integration — the send-claim ledger runs under the RLS runtime role
 * (raw-pg audit 2026-10-23 §4 P1.6).
 *
 * `send_claims` gates every proposal-execution, drip, thank-you and
 * transactional SMS. Its five tenant statements (claimSend,
 * markSendClaimSending, markSendClaimComplete, releaseSendClaim,
 * readSendClaimStatus) ran `WHERE tenant_id = $1` / `VALUES ($1, …)` straight
 * on the pool, as the privileged principal, so the predicate was the only
 * tenant boundary. With RLS_RUNTIME_ROLE on, this suite proves:
 *
 *   1. every ledger statement — direct and through withSendClaim — reports
 *      `rls_app_runtime` with the claiming tenant's GUC;
 *   2. with the tenant pin widened to both seeded tenants, RLS alone keeps
 *      the other tenant's same-key row untouched (UPDATE, DELETE) and unread
 *      (SELECT); a claim INSERT re-stamped with the other tenant is refused
 *      by the policy's WITH CHECK;
 *   3. control: the same rewritten statements as the connection principal DO
 *      reach the other tenant — so (2) is a test that can fail;
 *   4. the role holds what the ledger needs once migration 219's revocations
 *      are applied;
 *   5. the claim still commits on its own (the behaviour P1.6 leaves to the
 *      owner): inside a request transaction the claim, the 'sending' flip and
 *      the tombstone are committed before the next step, visible to another
 *      connection, and survive the request's rollback — the request client
 *      runs none of them;
 *   6. the cost: one tenant session per ledger step, never two connections at
 *      once.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool, PoolClient, QueryResult } from 'pg';
import { closeSharedTestDb, createTestTenant, getSharedTestDb, TENANT_CONTEXT_WITH_ROLE_SQL } from './shared';
import { probeStatementRoles } from './statement-role-probe';
import { countPoolTraffic, runtimeRoleGrantsMissingAfter219, widenTenantPredicates } from './tenant-predicate-probe';
import {
  claimSend,
  markSendClaimComplete,
  markSendClaimSending,
  readSendClaimStatus,
  releaseSendClaim,
  withSendClaim,
} from '../../src/notifications/send-claim-ledger';
import { applyTenantContext } from '../../src/db/rls-runtime-role';
import { tenantContextStore } from '../../src/middleware/tenant-context';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgDncRepository } from '../../src/compliance/dnc';
import { PgConsentEventRepository } from '../../src/compliance/consent-events';
import { PgDispatchRepository } from '../../src/notifications/dispatch-repository';
import { InMemoryDeliveryProvider, type SmsMessage } from '../../src/notifications/delivery-provider';
import { createOutboundMessaging } from '../../src/notifications/outbound-messaging';
import { createLogger } from '../../src/logging/logger';

const ORIGINAL_FLAG = process.env.RLS_RUNTIME_ROLE;
const LEDGER = /send_claims/;
type Status = 'claimed' | 'sending' | 'sent';

let pool: Pool;
const tenantIds: string[] = [];

async function seedTenant(): Promise<string> {
  const { tenantId } = await createTestTenant(pool);
  tenantIds.push(tenantId);
  return tenantId;
}

async function seedClaim(tenantId: string, claimKey: string, status: Status): Promise<void> {
  await pool.query(
    `INSERT INTO send_claims (tenant_id, claim_key, status, claimed_at, sent_at)
     VALUES ($1, $2, $3, NOW(), CASE WHEN $3 = 'sent' THEN NOW() END)`,
    [tenantId, claimKey, status],
  );
}

/** The row's status, read on its own connection as the principal (null: no row). */
async function statusOf(tenantId: string, claimKey: string): Promise<string | null> {
  const { rows } = await pool.query<{ status: string }>(
    `SELECT status FROM send_claims WHERE tenant_id = $1 AND claim_key = $2`,
    [tenantId, claimKey],
  );
  return rows[0]?.status ?? null;
}

function uniqueKey(label: string): string {
  return `${label}:${crypto.randomUUID()}`;
}

type QueryFn = (text: unknown, values?: unknown) => Promise<QueryResult>;

/**
 * The INSERT analogue of widening a WHERE pin: claimSend's row is stamped
 * with `other` instead of the caller's tenant (`$1` still referenced, so the
 * parameter list is unchanged). Under the tenant role the policy's WITH CHECK
 * refuses it; `asPrincipal` (RESET ROLE first, the pre-migration shape) is
 * the control that the stamp can land at all.
 */
function restampClaims(real: Pool, other: string, opts: { asPrincipal?: boolean } = {}): { pool: Pool; rewritten: string[] } {
  const rewritten: string[] = [];
  const connect = async (): Promise<PoolClient> => {
    const client = await real.connect();
    const inner = client.query as unknown as QueryFn;
    (client as unknown as { query: QueryFn }).query = async (text, values) => {
      const sql = typeof text === 'string' ? text : null;
      if (sql === null || !/INSERT INTO send_claims/.test(sql)) return inner.call(client, text, values);
      const next = sql.replace(/VALUES \(\$1,/, `VALUES ((CASE WHEN $1::uuid IS NOT NULL THEN '${other}'::uuid END),`);
      rewritten.push(next);
      if (opts.asPrincipal) await inner.call(client, 'RESET ROLE');
      return inner.call(client, next, values);
    };
    const innerRelease = client.release;
    client.release = (err?: Error | boolean) => {
      delete (client as unknown as { query?: QueryFn }).query;
      return innerRelease(err);
    };
    return client;
  };
  const query = async (text: unknown, values?: unknown): Promise<QueryResult> => {
    const client = await connect();
    try {
      return await (client.query as unknown as QueryFn)(text, values);
    } finally {
      client.release();
    }
  };
  const proxied = new Proxy(real, {
    get(target, prop) {
      if (prop === 'connect') return connect;
      if (prop === 'query') return query;
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { pool: proxied, rewritten };
}

beforeAll(async () => {
  pool = await getSharedTestDb();
});

beforeEach(() => {
  process.env.RLS_RUNTIME_ROLE = 'true';
});

afterEach(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env.RLS_RUNTIME_ROLE;
  else process.env.RLS_RUNTIME_ROLE = ORIGINAL_FLAG;
});

afterAll(async () => {
  for (const id of tenantIds) {
    for (const table of ['message_dispatches', 'customers', 'send_claims', 'users']) {
      await pool.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [id]).catch(() => undefined);
    }
    await pool.query('DELETE FROM tenants WHERE id = $1', [id]).catch(() => undefined);
  }
  await closeSharedTestDb();
});

describe('send-claim ledger — every statement under the RLS runtime role (real Postgres)', () => {
  it('claimSend, markSendClaimSending, markSendClaimComplete, readSendClaimStatus and releaseSendClaim run as rls_app_runtime for the claiming tenant', async () => {
    const tenantId = await seedTenant();
    const sent = uniqueKey('direct-sent');
    const released = uniqueKey('direct-released');
    const probe = probeStatementRoles(pool, LEDGER);

    expect(await claimSend(probe.pool, tenantId, sent)).toBe(true);
    expect(await markSendClaimSending(probe.pool, tenantId, sent)).toBe(true);
    await markSendClaimComplete(probe.pool, tenantId, sent);
    expect(await readSendClaimStatus(probe.pool, tenantId, sent)).toBe('sent');
    expect(await claimSend(probe.pool, tenantId, released)).toBe(true);
    await releaseSendClaim(probe.pool, tenantId, released);

    expect(await statusOf(tenantId, sent)).toBe('sent');
    expect(await statusOf(tenantId, released)).toBeNull();
    expect(probe.seen.map((s) => s.sql.trim().split(/\s+/)[0])).toEqual(['INSERT', 'UPDATE', 'UPDATE', 'SELECT', 'INSERT', 'DELETE']);
    for (const s of probe.seen) expect(s).toMatchObject({ role: 'rls_app_runtime', tenantGuc: tenantId });
  });

  it('withSendClaim — the claim, the sending CAS, the tombstone, a lost claim\'s status read and a release — all as rls_app_runtime', async () => {
    const tenantId = await seedTenant();
    const key = uniqueKey('composed');
    const failing = uniqueKey('composed-failing');
    const probe = probeStatementRoles(pool, LEDGER);

    expect(await withSendClaim(probe.pool, tenantId, key, async () => 'ok')).toEqual({ outcome: 'sent', result: 'ok' });
    expect(await withSendClaim(probe.pool, tenantId, key, async () => 'again')).toEqual({ outcome: 'duplicate', priorStatus: 'sent' });
    await expect(
      withSendClaim(probe.pool, tenantId, failing, async () => {
        throw new Error('provider down');
      }),
    ).rejects.toThrow('provider down');

    expect(await statusOf(tenantId, failing)).toBeNull();
    // claim, CAS, tombstone; lost claim + its status read; claim, CAS, release.
    expect(probe.seen).toHaveLength(8);
    for (const s of probe.seen) expect(s).toMatchObject({ role: 'rls_app_runtime', tenantGuc: tenantId });
  });
});

describe('send-claim ledger — RLS alone keeps the other tenant\'s same-key claim out (real Postgres)', () => {
  /**
   * Seeds the same key for both tenants, runs each tenant-filtered ledger
   * statement for `caller` with the tenant pin widened to both, and reports
   * what became of the OTHER tenant's rows (and what the read answered).
   */
  async function runWidened(asPrincipal: boolean) {
    const caller = await seedTenant();
    const other = await seedTenant();
    const keys = { sending: uniqueKey('w-sending'), complete: uniqueKey('w-complete'), release: uniqueKey('w-release'), read: uniqueKey('w-read') };
    for (const t of [caller, other]) {
      await seedClaim(t, keys.sending, 'claimed');
      await seedClaim(t, keys.complete, 'sending');
      await seedClaim(t, keys.release, 'claimed');
    }
    await seedClaim(other, keys.read, 'sent');
    const widened = widenTenantPredicates(pool, { target: LEDGER, tenants: [caller, other], asPrincipal });

    expect(await markSendClaimSending(widened.pool, caller, keys.sending)).toBe(true);
    await markSendClaimComplete(widened.pool, caller, keys.complete);
    await releaseSendClaim(widened.pool, caller, keys.release);
    const read = await readSendClaimStatus(widened.pool, caller, keys.read);

    expect(widened.rewritten).toHaveLength(4);
    expect({
      sending: await statusOf(caller, keys.sending),
      complete: await statusOf(caller, keys.complete),
      release: await statusOf(caller, keys.release),
    }).toEqual({ sending: 'sending', complete: 'sent', release: null });
    return {
      read,
      other: {
        sending: await statusOf(other, keys.sending),
        complete: await statusOf(other, keys.complete),
        release: await statusOf(other, keys.release),
      },
    };
  }

  it('with the tenant pin widened to both tenants, the flip, the tombstone and the release leave the other tenant alone, and the read sees nothing of it', async () => {
    expect(await runWidened(false)).toEqual({
      read: null,
      other: { sending: 'claimed', complete: 'sending', release: 'claimed' },
    });
  });

  it('control: the same widened statements run as the connection principal flip, tombstone, delete and read the other tenant\'s rows', async () => {
    expect(await runWidened(true)).toEqual({
      read: 'sent',
      other: { sending: 'sending', complete: 'sent', release: null },
    });
  });

  it('a claim re-stamped with the other tenant is refused by the policy\'s WITH CHECK', async () => {
    const caller = await seedTenant();
    const other = await seedTenant();
    const key = uniqueKey('restamp');
    const restamped = restampClaims(pool, other);

    await expect(claimSend(restamped.pool, caller, key)).rejects.toThrow(/row-level security/);

    expect(restamped.rewritten).toHaveLength(1);
    expect(await statusOf(other, key)).toBeNull();
    expect(await statusOf(caller, key)).toBeNull();
  });

  it('control: the same re-stamped claim run as the connection principal lands in the other tenant', async () => {
    const caller = await seedTenant();
    const other = await seedTenant();
    const key = uniqueKey('restamp-principal');
    const restamped = restampClaims(pool, other, { asPrincipal: true });

    expect(await claimSend(restamped.pool, caller, key)).toBe(true);

    expect(await statusOf(other, key)).toBe('claimed');
  });
});

describe('grants: rls_app_runtime keeps what the ledger needs after migration 219', () => {
  it('send_claims stays readable, insertable, updatable and deletable', async () => {
    expect(
      await runtimeRoleGrantsMissingAfter219(pool, [
        ['send_claims', 'SELECT'],
        ['send_claims', 'INSERT'],
        ['send_claims', 'UPDATE'],
        ['send_claims', 'DELETE'],
      ]),
    ).toEqual([]);
  });
});

describe('send-claim ledger — a claim commits on its own, never with the request (P1.6 behaviour preserved)', () => {
  /** A request transaction for `tenantId`, as the /api middleware opens one, recording what it runs. */
  async function openRequest(tenantId: string) {
    const client = await pool.connect();
    const ran: string[] = [];
    const inner = client.query.bind(client) as unknown as QueryFn;
    (client as unknown as { query: QueryFn }).query = (text, values) => {
      ran.push(typeof text === 'string' ? text : String((text as { text?: string })?.text ?? ''));
      return inner(text, values);
    };
    await client.query('BEGIN');
    await applyTenantContext(client, tenantId, { transactional: true });
    return {
      ran,
      run: <T>(fn: () => Promise<T>) => tenantContextStore.run({ client, tenantId }, fn),
      rollback: async () => {
        await client.query('ROLLBACK');
        delete (client as unknown as { query?: QueryFn }).query;
        client.release();
      },
    };
  }

  it('inside a request transaction, each step is committed before the next — visible to another connection — and survives the request\'s rollback', async () => {
    const tenantId = await seedTenant();
    const key = uniqueKey('inside-request');
    const traffic = countPoolTraffic(pool);
    const request = await openRequest(tenantId);
    let seenDuringPrep: string | null = 'unset';
    let seenAtProvider: string | null = 'unset';

    const outcome = await request.run(() =>
      withSendClaim(
        traffic.pool,
        tenantId,
        key,
        async (_accepted, markProviderStarting) => {
          seenDuringPrep = await statusOf(tenantId, key);
          await markProviderStarting();
          seenAtProvider = await statusOf(tenantId, key);
          return 'ok';
        },
        undefined,
        { deferSendingUntilProviderStart: true },
      ),
    );
    await request.rollback();

    expect(outcome).toEqual({ outcome: 'sent', result: 'ok' });
    expect(seenDuringPrep).toBe('claimed');
    expect(seenAtProvider).toBe('sending');
    expect(await statusOf(tenantId, key)).toBe('sent');
    // The ledger took its own checkouts; the request client ran none of its statements.
    expect(traffic.checkouts()).toBe(3);
    expect(request.ran.filter((sql) => LEDGER.test(sql))).toEqual([]);
  });

  it('a release inside a request transaction is committed at once too: the key is free to another connection before the request ends', async () => {
    const tenantId = await seedTenant();
    const key = uniqueKey('release-inside-request');
    const request = await openRequest(tenantId);

    await expect(
      request.run(() =>
        withSendClaim(pool, tenantId, key, async () => {
          throw new Error('provider down');
        }),
      ),
    ).rejects.toThrow('provider down');
    const claimedElsewhere = await claimSend(pool, tenantId, key);
    await request.rollback();

    expect(claimedElsewhere).toBe(true);
    expect(await statusOf(tenantId, key)).toBe('claimed');
    expect(request.ran.filter((sql) => LEDGER.test(sql))).toEqual([]);
  });
});

describe('send-claim ledger — cost: one tenant session per ledger step (real Postgres)', () => {
  const cost = (traffic: ReturnType<typeof countPoolTraffic>) => ({
    checkouts: traffic.checkouts(),
    statements: traffic.statements().length,
    maxOpen: traffic.maxOpen(),
  });

  it('each ledger call is one session: BEGIN, the GUC + role, its statement, COMMIT (base: 1 checkout / 1 statement)', async () => {
    const tenantId = await seedTenant();
    const key = uniqueKey('cost-direct');
    const released = uniqueKey('cost-released');
    const calls: Array<[string, (p: Pool) => Promise<unknown>]> = [
      ['claimSend', (p) => claimSend(p, tenantId, key)],
      ['markSendClaimSending', (p) => markSendClaimSending(p, tenantId, key)],
      ['markSendClaimComplete', (p) => markSendClaimComplete(p, tenantId, key)],
      ['readSendClaimStatus', (p) => readSendClaimStatus(p, tenantId, key)],
      ['claimSend (2)', (p) => claimSend(p, tenantId, released)],
      ['releaseSendClaim', (p) => releaseSendClaim(p, tenantId, released)],
    ];
    for (const [name, call] of calls) {
      const traffic = countPoolTraffic(pool);
      await call(traffic.pool);
      expect({ name, ...cost(traffic) }).toEqual({ name, checkouts: 1, statements: 4, maxOpen: 1 });
      expect(traffic.statements()[0]).toBe('BEGIN');
      expect(traffic.statements()[1]).toBe(TENANT_CONTEXT_WITH_ROLE_SQL);
      expect(traffic.statements()[3]).toBe('COMMIT');
    }
  });

  it('withSendClaim: a send is three sessions, a miss two, never two connections at once', async () => {
    const tenantId = await seedTenant();
    const measure = async (
      send: (accepted: () => void, starting: () => Promise<void>) => Promise<string>,
      options?: { deferSendingUntilProviderStart: true },
      key = uniqueKey('cost-composed'),
    ) => {
      const traffic = countPoolTraffic(pool);
      await withSendClaim(traffic.pool, tenantId, key, send, undefined, options).catch(() => undefined);
      return cost(traffic);
    };

    // Base (bare pool.query per step): 3 / 3 for a send or a release, 2 / 2 for a miss.
    // claim, CAS, tombstone.
    expect(await measure(async () => 'ok')).toEqual({ checkouts: 3, statements: 12, maxOpen: 1 });
    // Deferred: claim, CAS at markProviderStarting, tombstone.
    expect(
      await measure(async (_a, starting) => {
        await starting();
        return 'ok';
      }, { deferSendingUntilProviderStart: true }),
    ).toEqual({ checkouts: 3, statements: 12, maxOpen: 1 });
    // Deferred with no provider phase (the thank-you audit claim): claim, tombstone.
    expect(await measure(async () => 'ok', { deferSendingUntilProviderStart: true })).toEqual({ checkouts: 2, statements: 8, maxOpen: 1 });
    // The SMS claim + release path: claim, CAS, release.
    expect(
      await measure(async () => {
        throw new Error('provider down');
      }),
    ).toEqual({ checkouts: 3, statements: 12, maxOpen: 1 });
    // A miss: the lost claim, then the read of what holds the key.
    const held = uniqueKey('cost-held');
    await seedClaim(tenantId, held, 'sent');
    expect(await measure(async () => 'never', undefined, held)).toEqual({ checkouts: 2, statements: 8, maxOpen: 1 });
  });

  it('an outbound text (sendText): the pre-check, claim, CAS at the provider and tombstone are four sessions (base: 4 / 4)', async () => {
    const tenant = await createTestTenant(pool);
    tenantIds.push(tenant.tenantId);
    const customerId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO customers (id, tenant_id, first_name, last_name, display_name,
         primary_phone, preferred_channel, sms_consent, is_archived, created_by)
       VALUES ($1, $2, 'Mary', 'Johnson', 'Mary Johnson', '+15125550142', 'sms', true, false, $3)`,
      [customerId, tenant.tenantId, tenant.userId],
    );
    // The gate calls onProviderStarting right before the provider; so does this one.
    const inner = new InMemoryDeliveryProvider();
    const delivery = Object.assign(Object.create(inner) as InMemoryDeliveryProvider, {
      sendSms: async (message: SmsMessage) => {
        await message.onProviderStarting?.();
        return inner.sendSms(message);
      },
    });
    const traffic = countPoolTraffic(pool);
    const messaging = createOutboundMessaging({
      delivery,
      customerRepo: new PgCustomerRepository(pool),
      dncRepo: new PgDncRepository(pool),
      consentLedger: new PgConsentEventRepository(pool),
      dispatchRepo: new PgDispatchRepository(pool),
      pool: traffic.pool,
      logger: createLogger({ service: 'test', environment: 'test', level: 'error' }),
    });

    const outcome = await messaging.sendText({
      tenantId: tenant.tenantId,
      recipient: { kind: 'customer', customerId },
      purpose: 'transactional',
      dedupe: { messageKind: 'cost_text', recordId: customerId },
      body: 'Your tech is on the way',
    });

    expect(outcome.status).toBe('sent');
    expect(inner.sentSms).toHaveLength(1);
    expect(await statusOf(tenant.tenantId, `cost_text:${customerId}`)).toBe('sent');
    expect(cost(traffic)).toEqual({ checkouts: 4, statements: 16, maxOpen: 1 });
    expect(traffic.statements().filter((s) => LEDGER.test(s)).map((s) => s.trim().split(/\s+/)[0])).toEqual([
      'SELECT',
      'INSERT',
      'UPDATE',
      'UPDATE',
    ]);
  });
});
