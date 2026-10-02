/**
 * Docker-gated integration test for #1575 — cleaning up after a
 * change-number (#1563):
 *   (1) the previous Vapi phone-number resource is deleted once the tenant
 *       has been repointed to the new number;
 *   (2) a Twilio number whose release failed (`provider_data.orphanedNumberSid`)
 *       is retried by a periodic sweeper, which never releases the tenant's
 *       active number and alerts the operator after repeated failures.
 *
 * Seams: the provisioning worker's handle() + the onboarding phone routes
 * (same as phone-pick-lifecycle), and the exported sweep runOrphanedNumberSweep.
 * Twilio HTTP is a STATEFUL fake; Vapi is a recording fake. The DB is real.
 * No real Twilio/Vapi calls.
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
import type { VapiClient } from '../../src/integrations/vapi/client';
import { runOrphanedNumberSweep } from '../../src/workers/orphaned-number-sweep';
import type { OperatorAlert } from '../../src/monitoring/alert-operator';

const KEY = 'a'.repeat(64);
const logger = createLogger({ service: 'test', environment: 'test', level: 'error' });

// Migration 274 makes a DID unique across tenants and the suite's database
// outlives a run, so every run draws fresh numbers (555-01xx is the fictional
// spirit; the 4-digit suffix is random per run).
const RUN = Math.floor(Math.random() * 900) + 100;
// Each test draws its own trio (a DID is unique across tenants).
let pickSeq = 0;
let FIRST_PICK = '';
let SECOND_PICK = '';
let THIRD_PICK = '';
function freshPicks(): void {
  const suffix = `${RUN}${pickSeq++}`;
  FIRST_PICK = `+1512557${suffix}`;
  SECOND_PICK = `+1737557${suffix}`;
  THIRD_PICK = `+1830557${suffix}`;
}

type Init = { method?: string; body?: unknown } | undefined;

function stubTwilioAccount(opts: { attachFailsFor?: string; unavailable?: string } = {}) {
  const owned = new Map<string, string>(); // sid → E.164
  /** While true, every number release (DELETE) fails with a Twilio 500. */
  const control = { failReleases: false };
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
      if (control.failReleases) {
        return { ok: false, status: 500, json: async () => ({}), text: async () => 'release blew up' };
      }
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
  return { fn, owned, control };
}

function buildApp(pool: Pool, queue: InMemoryQueue, tenantId: string, userId: string) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = {
      userId,
      sessionId: 'session-1575',
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
    id: 'msg-checkout-1575',
    type: PROVISION_TWILIO_JOB_TYPE,
    payload: { tenantId, region: null, baseUrl: 'https://api.test' },
    attempts: 1,
    maxAttempts: 3,
    idempotencyKey: `provision-twilio-${tenantId}`,
    createdAt: new Date().toISOString(),
  };
}

/** Drain every queued provisioning job through the worker, in order. */
async function drain(queue: InMemoryQueue, pool: Pool, vapiClient?: VapiClient): Promise<number> {
  const worker = createProvisionTwilioWorker({ pool, ...(vapiClient ? { vapiClient } : {}) });
  let n = 0;
  for (let m = await queue.receive<ProvisionTwilioPayload>(); m; m = await queue.receive()) {
    expect(m.type).toBe(PROVISION_TWILIO_JOB_TYPE);
    await worker.handle(m, logger);
    await queue.delete(m.id);
    n++;
  }
  return n;
}

/** Recording Vapi fake: every link mints a fresh phone-number id. */
function fakeVapi() {
  let seq = 0;
  const live = new Set<string>();
  const client: VapiClient = {
    createAssistant: vi.fn(async () => ({ assistantId: 'asst-1575' })),
    updateAssistant: vi.fn(async () => undefined),
    linkPhoneNumber: vi.fn(async () => {
      const phoneNumberId = `vpn-1575-${++seq}`;
      live.add(phoneNumberId);
      return { phoneNumberId };
    }),
    deletePhoneNumber: vi.fn(async (id: string) => {
      live.delete(id);
    }),
  };
  return { client, live };
}

describe('Postgres integration — change-number cleanup (#1575)', () => {
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
    freshPicks();
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

  /** Checkout → pick FIRST_PICK → active, with the Vapi fake wired in. */
  async function activeTenantWithVapi(vapi: VapiClient) {
    const { tenantId, userId } = await createTestTenant(pool);
    await pool.query(`UPDATE tenants SET subscription_status = 'trialing' WHERE id = $1`, [tenantId]);
    await pool.query(
      `INSERT INTO tenant_settings (tenant_id, business_name) VALUES ($1, 'Cleanup Plumbing')`,
      [tenantId],
    );
    const twilio = stubTwilioAccount();
    const queue = new InMemoryQueue();
    const app = buildApp(pool, queue, tenantId, userId);
    await createProvisionTwilioWorker({ pool, vapiClient: vapi }).handle(checkoutMessage(tenantId), logger);
    await request(app).post('/api/onboarding/phone/claim').send({ phoneNumber: FIRST_PICK });
    await drain(queue, pool, vapi);
    const line = await request(app).get('/api/onboarding/phone');
    expect(line.body).toMatchObject({ state: 'active', phoneNumber: FIRST_PICK });
    return { tenantId, twilio, queue, app };
  }

  it('each change-number deletes the previous Vapi phone-number resource, leaving only the new one', async () => {
    const vapi = fakeVapi();
    const { queue, app } = await activeTenantWithVapi(vapi.client);
    expect([...vapi.live]).toEqual(['vpn-1575-1']);

    await request(app).post('/api/onboarding/phone/change').send({ phoneNumber: SECOND_PICK });
    await drain(queue, pool, vapi.client);
    expect(vapi.client.deletePhoneNumber).toHaveBeenCalledWith('vpn-1575-1');
    expect([...vapi.live]).toEqual(['vpn-1575-2']);

    await request(app).post('/api/onboarding/phone/change').send({ phoneNumber: THIRD_PICK });
    await drain(queue, pool, vapi.client);
    expect([...vapi.live]).toEqual(['vpn-1575-3']);
    const line = await request(app).get('/api/onboarding/phone');
    expect(line.body).toMatchObject({ state: 'active', phoneNumber: THIRD_PICK, changeError: null });
  });

  function sweepDeps(tenantId: string) {
    const alerts: OperatorAlert[] = [];
    return {
      alerts,
      deps: {
        pool,
        listTenantIds: async () => [tenantId],
        encKey: KEY,
        alert: async (a: OperatorAlert) => {
          alerts.push(a);
        },
        logger,
      },
    };
  }

  /** Active on FIRST_PICK, then a change to SECOND_PICK whose old-number release fails. */
  async function tenantWithOrphanedOldNumber() {
    const t = await activeTenantWithVapi(fakeVapi().client);
    t.twilio.control.failReleases = true;
    await request(t.app).post('/api/onboarding/phone/change').send({ phoneNumber: SECOND_PICK });
    await drain(t.queue, pool);
    t.twilio.control.failReleases = false;
    const line = await request(t.app).get('/api/onboarding/phone');
    expect(line.body).toMatchObject({ state: 'active', phoneNumber: SECOND_PICK, changeError: null });
    // The tenant briefly owns two numbers — the precondition #1575 cleans up.
    expect([...t.twilio.owned.values()].sort()).toEqual([FIRST_PICK, SECOND_PICK].sort());
    return t;
  }

  it('the sweeper releases an orphaned previous number, and a later sweep has nothing left to do', async () => {
    const t = await tenantWithOrphanedOldNumber();
    const { deps, alerts } = sweepDeps(t.tenantId);

    await runOrphanedNumberSweep(deps);
    expect([...t.twilio.owned.values()]).toEqual([SECOND_PICK]);

    t.twilio.fn.mockClear();
    await runOrphanedNumberSweep(deps);
    const deletes = t.twilio.fn.mock.calls.filter(([, init]) => (init as { method?: string } | undefined)?.method === 'DELETE');
    expect(deletes).toHaveLength(0);
    expect(alerts).toEqual([]);
    const line = await request(t.app).get('/api/onboarding/phone');
    expect(line.body).toMatchObject({ state: 'active', phoneNumber: SECOND_PICK });
  });

  it("never releases the tenant's active number, even if the marker names it", async () => {
    const t = await activeTenantWithVapi(fakeVapi().client);
    // Arrange a corrupt marker pointing at the ACTIVE number (e.g. the owner
    // changed back to a number whose release had failed and it was reused).
    await pool.query(
      `UPDATE tenant_integrations
          SET provider_data = provider_data || jsonb_build_object('orphanedNumberSid', provider_data->>'phoneNumberSid')
        WHERE tenant_id = $1 AND provider = 'twilio'`,
      [t.tenantId],
    );
    const { deps } = sweepDeps(t.tenantId);
    t.twilio.fn.mockClear();

    await runOrphanedNumberSweep(deps);

    const deletes = t.twilio.fn.mock.calls.filter(([, init]) => (init as { method?: string } | undefined)?.method === 'DELETE');
    expect(deletes).toHaveLength(0);
    expect([...t.twilio.owned.values()]).toEqual([FIRST_PICK]);
    const line = await request(t.app).get('/api/onboarding/phone');
    expect(line.body).toMatchObject({ state: 'active', phoneNumber: FIRST_PICK });
  });

  it('keeps retrying a failing release, pages the operator once after N failures, then succeeds', async () => {
    const t = await tenantWithOrphanedOldNumber();
    const { deps, alerts } = sweepDeps(t.tenantId);
    const sweep = () => runOrphanedNumberSweep({ ...deps, alertAfterFailures: 3 });
    t.twilio.control.failReleases = true;

    await sweep();
    await sweep();
    expect(alerts).toEqual([]);
    await sweep();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      severity: 'warning',
      rule: expect.stringMatching(/^orphaned_number_release:PN/),
      details: { tenantId: t.tenantId, failures: 3 },
    });
    await sweep(); // 4th failure: still retried, not re-paged
    expect(alerts).toHaveLength(1);
    expect([...t.twilio.owned.values()].sort()).toEqual([FIRST_PICK, SECOND_PICK].sort());

    t.twilio.control.failReleases = false;
    await sweep();
    expect([...t.twilio.owned.values()]).toEqual([SECOND_PICK]);
    expect(alerts).toHaveLength(1);
  });
});
