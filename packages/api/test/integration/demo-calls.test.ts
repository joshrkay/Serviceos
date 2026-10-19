/**
 * Postgres integration — S6-3 of the "pick, don't build" plan (U7 Approach,
 * "Only a `Calls` request that provably created no call releases anything
 * at once", "Lease lifetime (a)", "Callback binding (both URLs signed)",
 * the Error and Unconfirmed scenarios; D11's first test).
 *
 * The real router (`demo/routes.ts`) on the real service, the real start
 * transaction, the real lease pick, the real release and the real limiter,
 * on real Postgres. Twilio is a local fake HTTP (and, for the certificate
 * case, HTTPS) server that records every `Calls` request; nothing is
 * mocked. The one injected piece is the request's abort signal factory, so
 * a timeout can be fired without waiting 10 s; one case still runs the real
 * `AbortSignal.timeout(10 s)`.
 *
 * D11: a preflight failure or a definitive 4xx leaves the same-day retry
 * free (allowance count 0, the retry is placed); a timeout or a 5xx keeps
 * the allowance (the retry answers 429); a replayed release returns it once.
 *
 * Shared-DB rule: each case owns a far-future UTC day (injected clock) and a
 * fresh number. It adds three plumbing demo tenants so a free one always
 * exists, and releases every lease its numbers took after each case.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { randomInt, randomUUID } from 'crypto';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import type { Pool } from 'pg';
import { getSharedTestDb } from './shared';
import { createDemoCallsRouter } from '../../src/demo/routes';
import { hashDemoPhone, type DemoCallServiceDeps } from '../../src/demo/service';
import { loadDemoConfig } from '../../src/demo/config';
import { budgetDayFor, releaseNoCall, DEMO_CALL_ALLOWANCE_SCOPE } from '../../src/demo/call-budget';
import { verifyLeaseToken } from '../../src/demo/lease-token';
import { CALLS_REQUEST_TIMEOUT_MS, PRE_LIVE_WINDOW_S, demoLeaseStep } from '../../src/demo/lease';
import { runStartTransaction } from '../../src/demo/start-transaction';
import { DEMO_PLATFORM_TENANT_ID } from '../../src/demo/platform-tenant';
import { setPlatformTenantContext } from '../../src/demo/platform-audit';
import { createDemoLeaseResetter } from '../../src/demo/reset';
import { DevStorageProvider } from '../../src/files/storage-provider';
import { createPoolSlotTenant } from './demo-pool-tenant';

const SECRET = 'demo-calls-integration-secret';
const ACCOUNT_SID = 'ACdemotest';
const FROM = '+15125550100';
const PUBLIC_API = 'https://demo-api.example.test';

const DAY_MS = 24 * 60 * 60 * 1000;
const BASE_DAY_MS = Date.UTC(2400, 0, 1) + randomInt(0, 2_000_000) * DAY_MS;
let dayCounter = 0;
function freshDay(): Date {
  dayCounter += 2;
  return new Date(BASE_DAY_MS + dayCounter * DAY_MS + 12 * 60 * 60 * 1000);
}

const usedNumbers: string[] = [];
function freshNumber(): string {
  const n = `+1512${randomInt(200, 1000)}${String(randomInt(0, 10_000)).padStart(4, '0')}`;
  usedNumbers.push(n);
  return n;
}

const sid = () => `CA${randomUUID().replace(/-/g, '')}`;
const twilioError = (status: number, code: number) =>
  JSON.stringify({ code, message: `error ${code}`, more_info: `https://www.twilio.com/docs/errors/${code}`, status });

interface SeenRequest {
  path: string;
  auth: string | undefined;
  body: URLSearchParams;
  /** The lease and demo_calls rows as committed when the request arrived. */
  committed: { leaseCallSid: string | null; leaseState: string; callStatus: string } | null;
}

type Behaviour = (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void | Promise<void>;

describe('Postgres integration — demo call start (S6-3)', () => {
  let pool: Pool;
  let fake: http.Server;
  let fakeBase: string;
  let tls: https.Server;
  let tlsBase: string;
  let closedPortBase: string;
  let behaviour: Behaviour;
  let seen: SeenRequest[] = [];
  let tlsSeen = 0;
  const tenantIds: string[] = [];

  beforeAll(async () => {
    pool = await getSharedTestDb();
    // Pool-slot-shaped (S6-4): a no-call lease now ends through the reset,
    // whose re-seed names the business from the slot in the owner id. The
    // start call leases ANY free plumbing tenant, and a reused local
    // database can still hold plumbing demo tenants left by earlier versions
    // of these files (`demo-calls-test:<uuid>`, `demo:probe:<uuid>` owner
    // ids) that no reset can re-seed: take those out of the pool. A fresh
    // database has none.
    await pool.query(
      `UPDATE tenants SET demo_trade = NULL
        WHERE demo AND demo_trade = 'plumbing' AND owner_id !~ '^demo:plumbing:[0-9]+$'`,
    );
    for (let i = 0; i < 3; i += 1) {
      tenantIds.push((await createPoolSlotTenant(pool)).tenantId);
    }

    fake = http.createServer((req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (c: string) => (body += c));
      req.on('end', async () => {
        const params = new URLSearchParams(body);
        const lease = new URL(params.get('Url') ?? 'http://x/').searchParams.get('lease');
        const v = lease ? verifyLeaseToken(lease, SECRET, new Date(0)) : null;
        let committed: SeenRequest['committed'] = null;
        if (v && v.ok) {
          const { rows } = await pool.query(
            `SELECT l.call_sid AS lease_call_sid, l.state, c.status
               FROM demo_tenant_leases l JOIN demo_calls c ON c.lease_id = l.id WHERE l.id = $1`,
            [v.leaseId],
          );
          if (rows[0]) committed = { leaseCallSid: rows[0].lease_call_sid, leaseState: rows[0].state, callStatus: rows[0].status };
        }
        seen.push({ path: req.url ?? '', auth: req.headers.authorization, body: params, committed });
        await behaviour(req, res, body);
      });
    });
    await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
    fakeBase = `http://127.0.0.1:${(fake.address() as net.AddressInfo).port}/2010-04-01`;

    const dir = mkdtempSync(path.join(tmpdir(), 'demo-calls-tls-'));
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
      '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'),
    ], { stdio: 'ignore' });
    tls = https.createServer({ key: readFileSync(path.join(dir, 'k.pem')), cert: readFileSync(path.join(dir, 'c.pem')) }, (_q, s) => {
      tlsSeen += 1;
      s.end('{}');
    });
    await new Promise<void>((r) => tls.listen(0, '127.0.0.1', r));
    tlsBase = `https://127.0.0.1:${(tls.address() as net.AddressInfo).port}/2010-04-01`;

    const probe = net.createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
    closedPortBase = `http://127.0.0.1:${(probe.address() as net.AddressInfo).port}/2010-04-01`;
    await new Promise<void>((r) => probe.close(() => r()));
  });

  afterEach(async () => {
    seen = [];
    await pool.query(
      `UPDATE demo_tenant_leases SET state = 'released', released_at = now()
        WHERE released_at IS NULL AND (tenant_id = ANY($1::uuid[]) OR visitor_phone_hash = ANY($2::text[]))`,
      [tenantIds, usedNumbers.map((n) => hashDemoPhone(n, SECRET))],
    );
  });

  afterAll(async () => {
    await new Promise<void>((r) => fake.close(() => r()));
    await new Promise<void>((r) => tls.close(() => r()));
  });

  const created: Behaviour = (_q, res) => {
    res.writeHead(201, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ sid: sid(), status: 'queued' }));
  };

  function appFor(at: Date, overrides: Partial<DemoCallServiceDeps> = {}) {
    const a = express();
    a.use(express.json());
    a.use(
      '/public/demo',
      createDemoCallsRouter({
        pool,
        config: loadDemoConfig({}),
        isEnabled: () => true,
        getCreds: () => ({ accountSid: ACCOUNT_SID, authToken: 'fake-token', fromE164: FROM }),
        leaseTokenSecret: SECRET,
        publicApiUrl: PUBLIC_API,
        alert: async () => undefined,
        resetter: createDemoLeaseResetter({
          pool,
          settings: { resetBatchRows: 1000, resetDrainSeconds: 1 },
          alert: async () => undefined,
          storage: new DevStorageProvider({ bucket: 'demo-bucket', publicUrlBase: 'http://localhost/storage-dev' }),
          heartbeatMs: 3_600_000,
        }),
        apiBaseUrl: fakeBase,
        now: () => at,
        ...overrides,
      }),
    );
    return a;
  }

  const post = (a: express.Express, phone: string) =>
    request(a).post('/public/demo/calls').send({ phone, trade: 'plumbing', businessName: 'Austin Pipe Pros' });

  async function callRow(correlationId: string) {
    const { rows } = await pool.query(
      `SELECT c.*, l.state AS lease_state, l.call_sid AS lease_call_sid, l.released_at AS lease_released_at,
              l.renewed_at AS lease_renewed_at, l.leased_at, l.expires_at, l.generation, l.tenant_id AS lease_tenant_id
         FROM demo_calls c JOIN demo_tenant_leases l ON l.id = c.lease_id WHERE c.correlation_id = $1`,
      [correlationId],
    );
    return rows[0];
  }

  async function budget(at: Date) {
    const { rows } = await pool.query(`SELECT calls_reserved, est_cost_cents FROM demo_call_budget WHERE day = $1::date`, [
      budgetDayFor(at),
    ]);
    return rows[0] ?? { calls_reserved: 0, est_cost_cents: 0 };
  }

  async function allowance(phone: string): Promise<number> {
    const { rows } = await pool.query<{ n: number }>(
      `SELECT COALESCE(SUM(count), 0)::int AS n FROM phone_rate_limits WHERE tenant_id = $1 AND scope = $2 AND key = $3`,
      [DEMO_PLATFORM_TENANT_ID, DEMO_CALL_ALLOWANCE_SCOPE, hashDemoPhone(phone, SECRET)],
    );
    return rows[0].n;
  }

  async function audits(demoCallId: string): Promise<Array<{ event_type: string; metadata: Record<string, unknown> }>> {
    const { rows } = await pool.query(
      `SELECT event_type, metadata FROM audit_events WHERE tenant_id = $1 AND entity_id = $2 ORDER BY created_at, event_type`,
      [DEMO_PLATFORM_TENANT_ID, demoCallId],
    );
    return rows;
  }

  async function outboxRows(demoCallId: string): Promise<number> {
    const { rowCount } = await pool.query(`SELECT 1 FROM demo_handoff_outbox WHERE demo_call_id = $1`, [demoCallId]);
    return rowCount ?? 0;
  }

  it('happy path: a valid US cell and plumbing → the call is created, both callback URLs carry the lease token, nothing renews', async () => {
    const at = freshDay();
    const phone = freshNumber();
    behaviour = created;
    const signals: unknown[] = [];
    const requestedMs: number[] = [];
    const a = appFor(at, {
      fetchImpl: async (url, init) => {
        signals.push(init?.signal);
        return fetch(url, init);
      },
      timeoutSignal: (ms) => {
        requestedMs.push(ms);
        return AbortSignal.timeout(ms);
      },
    });
    const res = await post(a, phone);
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ correlationId: expect.any(String), status: 'calling' });
    expect(Buffer.from(res.body.correlationId, 'base64url')).toHaveLength(16);

    // Exactly one Calls request, from the platform number, to the visitor.
    expect(seen).toHaveLength(1);
    const req = seen[0];
    expect(req.path).toBe(`/2010-04-01/Accounts/${ACCOUNT_SID}/Calls.json`);
    expect(req.auth).toBe(`Basic ${Buffer.from(`${ACCOUNT_SID}:fake-token`).toString('base64')}`);
    expect(req.body.get('To')).toBe(phone);
    expect(req.body.get('From')).toBe(FROM);
    expect(req.body.getAll('StatusCallbackEvent')).toEqual(['ringing', 'answered', 'completed']);
    expect(req.body.get('Timeout')).toBe('30');
    expect(req.body.get('TimeLimit')).toBe('90');
    // Lease lifetime (a): a real abort signal for the 10 s bound.
    expect(signals).toHaveLength(1);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(requestedMs).toEqual([CALLS_REQUEST_TIMEOUT_MS]);

    const row = await callRow(res.body.correlationId);
    // Callback binding (both URLs signed): the token names this lease.
    for (const key of ['Url', 'StatusCallback']) {
      const u = new URL(req.body.get(key)!);
      expect(u.origin).toBe(PUBLIC_API);
      const v = verifyLeaseToken(u.searchParams.get('lease')!, SECRET, at);
      expect(v).toEqual({
        ok: true,
        leaseId: row.lease_id,
        tenantId: row.lease_tenant_id,
        gen: Number(row.generation),
        sexp: row.callback_deadline_at,
      });
    }
    expect(new URL(req.body.get('Url')!).pathname).toBe('/public/demo/voice');
    expect(new URL(req.body.get('StatusCallback')!).pathname).toBe('/public/demo/status');
    // The lease and the call row were committed, call_sid null, before the request.
    expect(req.committed).toEqual({ leaseCallSid: null, leaseState: 'active', callStatus: 'initiating' });

    // Created: the sid is bound on both rows, and nothing renewed.
    const leased = await pool.query(`SELECT demo, demo_trade FROM tenants WHERE id = $1`, [row.lease_tenant_id]);
    expect(leased.rows[0]).toEqual({ demo: true, demo_trade: 'plumbing' });
    expect(row.call_sid).toMatch(/^CA[0-9a-f]{32}$/);
    expect(row.lease_call_sid).toBe(row.call_sid);
    expect(row.status).toBe('queued');
    expect(row.lease_state).toBe('active');
    expect(row.lease_renewed_at).toBeNull();
    expect(row.leased_at.getTime()).toBe(at.getTime());
    expect(row.expires_at.getTime()).toBe(at.getTime() + PRE_LIVE_WINDOW_S * 1000);
    // The D2 snapshot and the visitor's marketing lead.
    expect(row).toMatchObject({ trade: 'plumbing', business_name: 'Austin Pipe Pros', metro_code: 'AUS', metro_name: 'Austin' });
    expect(row.phone_hash).toBe(hashDemoPhone(phone, SECRET));
    const lead = await pool.query(`SELECT tenant_id, source, source_detail, primary_phone FROM leads WHERE id = $1`, [row.lead_id]);
    expect(lead.rows[0]).toMatchObject({ tenant_id: DEMO_PLATFORM_TENANT_ID, source: 'other', source_detail: 'demo_call' });
    // The reservation and the allowance are held.
    expect(await budget(at)).toMatchObject({ calls_reserved: 1, est_cost_cents: 50 });
    expect(row.budget_released_at).toBeNull();
    expect(await allowance(phone)).toBe(1);
    expect((await audits(row.id)).map((r) => r.event_type)).toEqual(
      expect.arrayContaining(['demo_call_started', 'demo_call_created']),
    );
  });

  it('the same number twice in a day → 429 with the friendly copy, no second Calls request', async () => {
    const at = freshDay();
    const phone = freshNumber();
    behaviour = created;
    const a = appFor(at);
    expect((await post(a, phone)).status).toBe(202);
    const again = await post(a, phone);
    expect(again.status).toBe(429);
    expect(again.body).toEqual({ error: 'DEMO_DAILY_LIMIT', message: "You've already had today's demo. Try again tomorrow." });
    expect(seen).toHaveLength(1);
    expect(await allowance(phone)).toBe(1);
  });

  it('the kill switch on → 503 DEMO_DISABLED, nothing written, no request', async () => {
    const at = freshDay();
    const phone = freshNumber();
    const res = await post(appFor(at, { isEnabled: () => false }), phone);
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('DEMO_DISABLED');
    expect(seen).toHaveLength(0);
    expect(await allowance(phone)).toBe(0);
    expect(await budget(at)).toMatchObject({ calls_reserved: 0 });
  });

  it.each([
    ['a premium number', '+19005550142'],
    ['a non-NANP number', '+447700900123'],
    ['a NANP-shaped number with an invalid area code', '+11235550142'],
  ])('%s → 400 DEMO_NUMBER_NOT_ALLOWED before any write, no request', async (_label, phone) => {
    const at = freshDay();
    usedNumbers.push(phone);
    const res = await post(appFor(at), phone);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'DEMO_NUMBER_NOT_ALLOWED', message: 'We can only call a US or Canadian phone number.' });
    expect(seen).toHaveLength(0);
    expect(await allowance(phone)).toBe(0);
    const { rowCount } = await pool.query(`SELECT 1 FROM demo_calls WHERE phone_hash = $1`, [hashDemoPhone(phone, SECRET)]);
    expect(rowCount).toBe(0);
    expect(await budget(at)).toMatchObject({ calls_reserved: 0 });
  });

  it('the day budget at its cap → 503 DEMO_BUSY, no Calls request, no allowance spent', async () => {
    const at = freshDay();
    const phone = freshNumber();
    const res = await post(appFor(at, { config: loadDemoConfig({ DEMO_CALLS_DAILY_CAP: '1' }) }), freshNumber());
    expect(res.status).toBe(202);
    const busy = await post(appFor(at, { config: loadDemoConfig({ DEMO_CALLS_DAILY_CAP: '1' }) }), phone);
    expect(busy.status).toBe(503);
    expect(busy.body).toEqual({ error: 'DEMO_BUSY', message: 'Every line is busy. Try again in a minute.' });
    expect(seen).toHaveLength(1);
    expect(await allowance(phone)).toBe(0);
  });

  // ── Not created: the only outcome that releases at once ────────────────
  const notCreated: Array<[string, () => Partial<DemoCallServiceDeps>, Behaviour | null, Record<string, unknown>]> = [
    ['Twilio 400 (an invalid To)', () => ({}), (_q, s) => { s.writeHead(400, { 'content-type': 'application/json' }); s.end(twilioError(400, 21211)); }, { reason: 'twilio_rejected', httpStatus: 400, twilioCode: 21211 }],
    ['Twilio 401', () => ({}), (_q, s) => { s.writeHead(401, { 'content-type': 'application/json' }); s.end(twilioError(401, 20003)); }, { reason: 'twilio_rejected', httpStatus: 401 }],
    ['Twilio 403', () => ({}), (_q, s) => { s.writeHead(403, { 'content-type': 'application/json' }); s.end(twilioError(403, 21215)); }, { reason: 'twilio_rejected', httpStatus: 403 }],
    ['Twilio 404', () => ({}), (_q, s) => { s.writeHead(404, { 'content-type': 'application/json' }); s.end(twilioError(404, 20404)); }, { reason: 'twilio_rejected', httpStatus: 404 }],
    ['Twilio 429', () => ({}), (_q, s) => { s.writeHead(429, { 'content-type': 'application/json' }); s.end(twilioError(429, 20429)); }, { reason: 'twilio_rejected', httpStatus: 429 }],
    ['a DNS failure', () => ({ apiBaseUrl: 'http://demo-twilio.invalid/2010-04-01' }), null, { reason: 'connect_failed' }],
    ['a refused connection', () => ({ apiBaseUrl: closedPortBase }), null, { reason: 'connect_failed', causeCode: 'ECONNREFUSED' }],
    ['a certificate failure', () => ({ apiBaseUrl: tlsBase }), null, { reason: 'connect_failed', causeCode: 'DEPTH_ZERO_SELF_SIGNED_CERT' }],
    ['a local validation failure (bad platform From)', () => ({ getCreds: () => ({ accountSid: ACCOUNT_SID, authToken: 't', fromE164: '512-555-0100' }) }), null, { reason: 'local_failure' }],
  ];

  for (const [label, depsFor, b, audit] of notCreated) {
    it(`not created — ${label} → failed, lease released, reservation and allowance returned once, no handoff; the same-day retry is placed (D11)`, async () => {
      const at = freshDay();
      const phone = freshNumber();
      behaviour = b ?? created;
      tlsSeen = 0;
      const res = await post(appFor(at, depsFor()), phone);
      expect(res.status).toBe(502);
      expect(res.body).toEqual({ error: 'DEMO_CALL_FAILED', message: "We couldn't place the call. Please try again in a few minutes." });
      expect(seen).toHaveLength(b ? 1 : 0);
      expect(tlsSeen).toBe(0);

      const row = await callRow(res.body.correlationId ?? '');
      const { rows } = await pool.query(`SELECT * FROM demo_calls WHERE phone_hash = $1`, [hashDemoPhone(phone, SECRET)]);
      expect(rows).toHaveLength(1);
      const call = row ?? (await pool.query(
        `SELECT c.*, l.state AS lease_state, l.released_at AS lease_released_at FROM demo_calls c JOIN demo_tenant_leases l ON l.id = c.lease_id WHERE c.id = $1`,
        [rows[0].id],
      )).rows[0];
      expect(call.status).toBe('failed');
      expect(call.call_sid).toBeNull();
      expect(call.lease_state).toBe('released');
      expect(call.lease_released_at).not.toBeNull();
      expect(call.budget_released_at).not.toBeNull();
      expect(call.allowance_released_at).not.toBeNull();
      expect(await budget(at)).toMatchObject({ calls_reserved: 0, est_cost_cents: 0 });
      expect(await allowance(phone)).toBe(0);
      expect(await outboxRows(call.id)).toBe(0);
      const events = await audits(call.id);
      expect(events.find((e) => e.event_type === 'demo_call_failed')?.metadata).toMatchObject({
        ...audit,
        budgetReturned: true,
        allowanceReturned: true,
      });
      expect(events.filter((e) => e.event_type === 'demo_call_budget_released')).toHaveLength(1);

      // S6-4: the lease ended through resetAndRelease (`no_call`), which
      // re-seeded the tenant from the fixture before releasing it.
      const leaseEvents = await pool.query<{ event_type: string; metadata: Record<string, unknown> }>(
        `SELECT event_type, metadata FROM audit_events WHERE tenant_id = $1 AND entity_id = $2 ORDER BY created_at`,
        [DEMO_PLATFORM_TENANT_ID, call.lease_id],
      );
      expect(leaseEvents.rows.map((e) => e.event_type)).toEqual(['demo_lease_reset_started', 'demo_lease_released']);
      expect(leaseEvents.rows[0].metadata).toMatchObject({ source: 'no_call' });
      const seeded = await pool.query(`SELECT 1 FROM tenant_settings WHERE tenant_id = (SELECT tenant_id FROM demo_tenant_leases WHERE id = $1)`, [
        call.lease_id,
      ]);
      expect(seeded.rowCount).toBe(1);

      // A replayed release returns nothing a second time.
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await setPlatformTenantContext(client);
        expect(await releaseNoCall(client, call.id)).toEqual({ released: false });
        await client.query('COMMIT');
      } finally {
        client.release();
      }
      expect(await budget(at)).toMatchObject({ calls_reserved: 0, est_cost_cents: 0 });

      // D11: the same-day retry is free and is placed.
      behaviour = created;
      seen = [];
      const retry = await post(appFor(at), phone);
      expect(retry.status).toBe(202);
      expect(seen).toHaveLength(1);
      expect(await allowance(phone)).toBe(1);
    });
  }

  // ── Unconfirmed: everything else keeps the lease, reservation and allowance ──
  const unconfirmed: Array<[string, Behaviour, string]> = [
    ['a socket reset after the request was read', (q) => { q.socket.resetAndDestroy(); }, 'reset_after_send'],
    ['a 502', (_q, s) => { s.writeHead(502, { 'content-type': 'text/html' }); s.end('<html>bad gateway</html>'); }, 'http_5xx'],
    ['a 503 after accept', (_q, s) => { s.writeHead(503, { 'content-type': 'application/json' }); s.end(twilioError(503, 20503)); }, 'http_5xx'],
    ['a 504', (_q, s) => { s.writeHead(504); s.end(); }, 'http_5xx'],
    ['a 409 with a Twilio body', (_q, s) => { s.writeHead(409, { 'content-type': 'application/json' }); s.end(twilioError(409, 20409)); }, 'unlisted_response'],
    ['a 400 whose body is HTML', (_q, s) => { s.writeHead(400, { 'content-type': 'text/html' }); s.end('<html>bad</html>'); }, 'unparsable_body'],
    ['a 201 with a truncated body', (q, s) => { s.writeHead(201, { 'content-type': 'application/json', 'content-length': '200' }); s.write('{"sid":"CA'); setTimeout(() => q.socket.destroy(), 20); }, 'unparsable_body'],
  ];

  async function expectUnconfirmed(correlationId: string, at: Date, phone: string, reason: string) {
    const row = await callRow(correlationId);
    expect(row.status).toBe('unconfirmed');
    expect(row.lease_state).toBe('active');
    expect(row.lease_call_sid).toBeNull();
    expect(row.lease_renewed_at).toBeNull();
    expect(row.expires_at.getTime()).toBe(at.getTime() + PRE_LIVE_WINDOW_S * 1000);
    expect(row.budget_released_at).toBeNull();
    expect(row.allowance_released_at).toBeNull();
    expect(await budget(at)).toMatchObject({ calls_reserved: 1, est_cost_cents: 50 });
    expect(await allowance(phone)).toBe(1);
    const lead = await pool.query(`SELECT 1 FROM leads WHERE id = $1`, [row.lead_id]);
    expect(lead.rowCount).toBe(1);
    const events = await audits(row.id);
    expect(events.filter((e) => e.event_type === 'demo_call_unconfirmed').map((e) => e.metadata.reason)).toEqual([reason]);
    expect(events.some((e) => e.event_type === 'demo_call_budget_released')).toBe(false);
    // D11: a timeout or 5xx keeps the allowance — the same-day retry is refused.
    behaviour = created;
    seen = [];
    const retry = await post(appFor(at), phone);
    expect(retry.status).toBe(429);
    expect(seen).toHaveLength(0);
  }

  for (const [label, b, reason] of unconfirmed) {
    it(`unconfirmed — ${label} → answered as calling, lease, reservation and allowance kept, exactly one request`, async () => {
      const at = freshDay();
      const phone = freshNumber();
      behaviour = b;
      const res = await post(appFor(at), phone);
      expect(res.status).toBe(202);
      expect(res.body.status).toBe('calling');
      expect(seen).toHaveLength(1);
      await expectUnconfirmed(res.body.correlationId, at, phone, reason);
    });
  }

  it('unconfirmed — a timeout (the fake accepted and never answered; the bound fires) → kept, never retried', async () => {
    const at = freshDay();
    const phone = freshNumber();
    const controller = new AbortController();
    behaviour = () => {
      // Hold the request open; the bound fires once Twilio has it.
      controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
    };
    const res = await post(appFor(at, { timeoutSignal: () => controller.signal }), phone);
    expect(res.status).toBe(202);
    expect(seen).toHaveLength(1);
    await expectUnconfirmed(res.body.correlationId, at, phone, 'timeout');
  });

  it('lease lifetime (a): the real AbortSignal bound aborts a stalled request at 10 s', async () => {
    const at = freshDay();
    const phone = freshNumber();
    behaviour = () => undefined; // never answers
    const started = Date.now();
    const res = await post(appFor(at), phone);
    const elapsed = Date.now() - started;
    expect(res.status).toBe(202);
    expect(elapsed).toBeGreaterThanOrEqual(CALLS_REQUEST_TIMEOUT_MS - 50);
    expect(elapsed).toBeLessThan(CALLS_REQUEST_TIMEOUT_MS + 5_000);
    expect(seen).toHaveLength(1);
    await expectUnconfirmed(res.body.correlationId, at, phone, 'timeout');
  }, 30_000);

  it('unconfirmed — a process killed between the commit and the request leaves the row initiating with everything held', async () => {
    const at = freshDay();
    const phone = freshNumber();
    const out = await runStartTransaction(
      pool,
      {
        phoneHash: hashDemoPhone(phone, SECRET),
        e164: phone,
        trade: 'plumbing',
        businessName: 'Killed Before Calling',
        correlationId: `killed-${randomUUID()}`,
      },
      demoLeaseStep,
      { config: loadDemoConfig({}), isEnabled: () => true, alert: async () => undefined, now: () => at },
    );
    expect(out.kind).toBe('started');
    if (out.kind !== 'started') throw new Error('unreachable');
    const { rows } = await pool.query(
      `SELECT c.status, c.budget_released_at, l.state, l.call_sid FROM demo_calls c JOIN demo_tenant_leases l ON l.id = c.lease_id WHERE c.id = $1`,
      [out.call.demoCallId],
    );
    expect(rows[0]).toEqual({ status: 'initiating', budget_released_at: null, state: 'active', call_sid: null });
    expect(await budget(at)).toMatchObject({ calls_reserved: 1 });
    expect(await allowance(phone)).toBe(1);
    expect(seen).toHaveLength(0);
  });
});
