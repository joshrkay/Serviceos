/**
 * Docker-gated integration test for #1563 — the tenant picks their number.
 *
 * Owner decisions (2026-10-01): trial checkout creates the subaccount +
 * Messaging Service ONLY; a number is bought only on an explicit pick
 * (/phone/claim) or "Pick one for me" (/phone/retry); a pick is never
 * silently swallowed; Settings → Phone can change the number (buy new →
 * attach → repoint → release old, never zero numbers on failure).
 *
 * Seams: the provisioning worker's handle() and the onboarding phone routes
 * (GET /phone, POST /phone/claim, POST /phone/change). Twilio HTTP is a
 * STATEFUL fake (purchases add to the subaccount, DELETEs remove) so "the old
 * number was released" can only pass if it genuinely was; the DB is real.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { Pool } from 'pg';
import { closeSharedTestDb, createTestTenant, getSharedTestDb } from './shared';
import {
  createProvisionTwilioWorker,
  PROVISION_TWILIO_JOB_TYPE,
  type ProvisionTwilioPayload,
} from '../../src/workers/provision-twilio';
import { createLogger } from '../../src/logging/logger';
import { InMemoryQueue, type QueueMessage } from '../../src/queues/queue';
import { createOnboardingRouter } from '../../src/routes/onboarding';
import { InMemorySettingsRepository } from '../../src/settings/settings';
import { InMemoryPackActivationRepository } from '../../src/settings/pack-activation';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import type { AuthenticatedRequest } from '../../src/auth/clerk';

const KEY = 'a'.repeat(64);
const logger = createLogger({ service: 'test', environment: 'test', level: 'error' });

// Migration 274 makes a DID unique across tenants and the suite's database
// outlives a run, so every run draws fresh numbers (555-01xx is the fictional
// spirit; the 4-digit suffix is random per run).
const RUN = String(Math.floor(Math.random() * 9000) + 1000);
const FIRST_PICK = `+1512556${RUN}`;
const SECOND_PICK = `+1737556${RUN}`;
const UNATTACHABLE = `+1830556${RUN}`;
const TAKEN = `+1915556${RUN}`;

type Init = { method?: string; body?: unknown } | undefined;

function stubTwilioAccount(opts: { attachFailsFor?: string; unavailable?: string } = {}) {
  const owned = new Map<string, string>(); // sid → E.164
  let seq = 0;
  const ok = (body: unknown) => ({
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
  const fn = vi.fn(async (url: string, init?: Init) => {
    const method = init?.method ?? 'GET';
    if (method === 'DELETE') {
      const sid = url.match(/IncomingPhoneNumbers\/(\w+)\.json/)?.[1];
      if (sid) owned.delete(sid);
      return ok({});
    }
    if (url.endsWith('/Accounts.json')) return ok({ sid: 'ACsub1563', auth_token: 'subtoken' });
    if (url.includes('messaging.twilio.com') && url.endsWith('/Services')) return ok({ sid: 'MG1563' });
    if (url.includes('messaging.twilio.com') && url.endsWith('/PhoneNumbers')) {
      const sid = new URLSearchParams(String(init?.body)).get('PhoneNumberSid');
      if (opts.attachFailsFor && sid && owned.get(sid) === opts.attachFailsFor) {
        return { ok: false, status: 500, json: async () => ({}), text: async () => 'attach blew up' };
      }
      return ok({});
    }
    if (url.includes('/AvailablePhoneNumbers/')) {
      return ok({ available_phone_numbers: [{ phone_number: FIRST_PICK }] });
    }
    if (url.includes('IncomingPhoneNumbers.json')) {
      if (method === 'POST') {
        const e164 = new URLSearchParams(String(init?.body)).get('PhoneNumber')!;
        if (e164 === opts.unavailable) {
          return { ok: false, status: 400, json: async () => ({}), text: async () => 'not available' };
        }
        const sid = `PN1563x${++seq}`;
        owned.set(sid, e164);
        return ok({ sid, phone_number: e164 });
      }
      return ok({
        incoming_phone_numbers: [...owned].map(([sid, phone_number]) => ({ sid, phone_number })),
      });
    }
    return ok({});
  });
  vi.stubGlobal('fetch', fn);
  return { fn, owned };
}

function buildApp(pool: Pool, queue: InMemoryQueue, tenantId: string, userId: string) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = {
      userId,
      sessionId: 'session-1563',
      tenantId,
      role: 'owner',
    };
    next();
  });
  app.use(
    '/api/onboarding',
    createOnboardingRouter({
      settingsRepo: new InMemorySettingsRepository(),
      packActivationRepo: new InMemoryPackActivationRepository(),
      auditRepo: new InMemoryAuditRepository(),
      pool,
      queue,
    }),
  );
  return app;
}

function checkoutMessage(tenantId: string): QueueMessage<ProvisionTwilioPayload> {
  return {
    id: 'msg-checkout-1563',
    type: PROVISION_TWILIO_JOB_TYPE,
    payload: { tenantId, region: null, baseUrl: 'https://api.test' },
    attempts: 1,
    maxAttempts: 3,
    idempotencyKey: `provision-twilio-${tenantId}`,
    createdAt: new Date().toISOString(),
  };
}

/** Drain every queued provisioning job through the worker, in order. */
async function drain(queue: InMemoryQueue, pool: Pool): Promise<number> {
  const worker = createProvisionTwilioWorker({ pool });
  let n = 0;
  for (let m = await queue.receive<ProvisionTwilioPayload>(); m; m = await queue.receive()) {
    expect(m.type).toBe(PROVISION_TWILIO_JOB_TYPE);
    await worker.handle(m, logger);
    await queue.delete(m.id);
    n++;
  }
  return n;
}

describe('Postgres integration — tenant picks their number (#1563)', () => {
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
    setEnv('VAPI_API_KEY', undefined);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    while (restore.length) {
      const [k, v] = restore.pop()!;
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('checkout → awaiting pick → claim → active → change number (old released) → failed change rolls back', async () => {
    const { tenantId, userId } = await createTestTenant(pool);
    await pool.query(`UPDATE tenants SET subscription_status = 'trialing' WHERE id = $1`, [tenantId]);
    const twilio = stubTwilioAccount({ attachFailsFor: UNATTACHABLE });
    const queue = new InMemoryQueue();
    const app = buildApp(pool, queue, tenantId, userId);

    // 1. Trial checkout: subaccount + Messaging Service, NO number.
    await createProvisionTwilioWorker({ pool }).handle(checkoutMessage(tenantId), logger);
    expect(twilio.owned.size).toBe(0);
    let line = await request(app).get('/api/onboarding/phone');
    expect(line.status).toBe(200);
    expect(line.body).toMatchObject({ state: 'awaiting_pick', phoneNumber: null });

    // 2. The owner picks a number → claiming, then the worker buys exactly it.
    const claim = await request(app).post('/api/onboarding/phone/claim').send({ phoneNumber: FIRST_PICK });
    expect(claim.status).toBe(200);
    line = await request(app).get('/api/onboarding/phone');
    expect(line.body).toMatchObject({ state: 'claiming', pendingNumber: FIRST_PICK });
    expect(await drain(queue, pool)).toBe(1);
    line = await request(app).get('/api/onboarding/phone');
    expect(line.body).toMatchObject({ state: 'active', phoneNumber: FIRST_PICK, pendingNumber: null });
    expect([...twilio.owned.values()]).toEqual([FIRST_PICK]);

    // 3. Settings → Phone: change number. New bought, old released.
    const change = await request(app).post('/api/onboarding/phone/change').send({ phoneNumber: SECOND_PICK });
    expect(change.status).toBe(200);
    line = await request(app).get('/api/onboarding/phone');
    expect(line.body).toMatchObject({ state: 'active', phoneNumber: FIRST_PICK, changingTo: SECOND_PICK });
    expect(await drain(queue, pool)).toBe(1);
    line = await request(app).get('/api/onboarding/phone');
    expect(line.body).toMatchObject({
      state: 'active',
      phoneNumber: SECOND_PICK,
      changingTo: null,
      changeError: null,
    });
    expect([...twilio.owned.values()]).toEqual([SECOND_PICK]);

    // 4. A change that fails mid-way (attach) rolls back: the tenant keeps
    // its current number and the half-bought one is handed back.
    const bad = await request(app).post('/api/onboarding/phone/change').send({ phoneNumber: UNATTACHABLE });
    expect(bad.status).toBe(200);
    await drain(queue, pool);
    line = await request(app).get('/api/onboarding/phone');
    expect(line.body).toMatchObject({ state: 'active', phoneNumber: SECOND_PICK, changingTo: null });
    expect(line.body.changeError).toMatch(/kept your current number/i);
    expect([...twilio.owned.values()]).toEqual([SECOND_PICK]);
  });

  it('a failed pick does not leave the line stuck "claiming": a re-run checkout job puts the tenant back on the picker', async () => {
    const { tenantId, userId } = await createTestTenant(pool);
    await pool.query(`UPDATE tenants SET subscription_status = 'trialing' WHERE id = $1`, [tenantId]);
    stubTwilioAccount({ unavailable: TAKEN });
    const queue = new InMemoryQueue();
    const app = buildApp(pool, queue, tenantId, userId);

    await createProvisionTwilioWorker({ pool }).handle(checkoutMessage(tenantId), logger);
    await request(app).post('/api/onboarding/phone/claim').send({ phoneNumber: TAKEN });
    await drain(queue, pool);
    let line = await request(app).get('/api/onboarding/phone');
    expect(line.body.state).toBe('failed');
    expect(line.body.lastError).toMatch(/no longer available/i);

    // The subscription webhook fires again (e.g. trialing → active).
    await createProvisionTwilioWorker({ pool }).handle(checkoutMessage(tenantId), logger);
    line = await request(app).get('/api/onboarding/phone');
    expect(line.body).toMatchObject({ state: 'awaiting_pick', pendingNumber: null });
  });
});

