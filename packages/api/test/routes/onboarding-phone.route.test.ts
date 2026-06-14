import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import { describe, it, expect, afterEach, vi } from 'vitest';
import type { Pool } from 'pg';
import { createOnboardingRouter } from '../../src/routes/onboarding';
import { InMemorySettingsRepository } from '../../src/settings/settings';
import { InMemoryPackActivationRepository } from '../../src/settings/pack-activation';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemoryQueue } from '../../src/queues/queue';
import { PROVISION_TWILIO_JOB_TYPE } from '../../src/workers/provision-twilio';
import { AuthenticatedRequest } from '../../src/auth/clerk';

const TENANT_ID = 'tenant-test-1';
const USER_ID = 'user-test-1';

type MockResponse = { ok?: boolean; status?: number; body: unknown };

function mockFetch(...responses: MockResponse[]): void {
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
}

function setEnv(key: string, value: string | undefined): string | undefined {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  return prev;
}

function buildApp(deps: { pool?: Pool; queue?: InMemoryQueue; auditRepo?: InMemoryAuditRepository } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = {
      userId: USER_ID,
      sessionId: 'session-test-1',
      tenantId: TENANT_ID,
      role: 'owner',
    };
    next();
  });
  const auditRepo = deps.auditRepo ?? new InMemoryAuditRepository();
  app.use(
    '/api/onboarding',
    createOnboardingRouter({
      settingsRepo: new InMemorySettingsRepository(),
      packActivationRepo: new InMemoryPackActivationRepository(),
      auditRepo,
      pool: deps.pool,
      queue: deps.queue,
    }),
  );
  return { app, auditRepo };
}

/** Minimal Pool stub for routes that only read tenant_integrations status. */
function fakePool(status: string | null): Pool {
  return {
    query: vi.fn(async () => ({ rows: status === null ? [] : [{ status }] })),
  } as unknown as Pool;
}

describe('POST /api/onboarding/phone/available', () => {
  const restore: Array<[string, string | undefined]> = [];
  afterEach(() => {
    vi.unstubAllGlobals();
    while (restore.length) {
      const [k, v] = restore.pop()!;
      setEnv(k, v);
    }
  });

  it('returns candidate numbers for a valid area code', async () => {
    restore.push(['TWILIO_ACCOUNT_SID', setEnv('TWILIO_ACCOUNT_SID', 'ACtest')]);
    restore.push(['TWILIO_AUTH_TOKEN', setEnv('TWILIO_AUTH_TOKEN', 'token')]);
    mockFetch({
      body: {
        available_phone_numbers: [
          { phone_number: '+15125550001', locality: 'Austin', region: 'TX' },
          { phone_number: '+15125550002', locality: 'Austin', region: 'TX' },
        ],
      },
    });

    const { app } = buildApp();
    const res = await request(app).post('/api/onboarding/phone/available').send({ areaCode: '512' });

    expect(res.status).toBe(200);
    expect(res.body.numbers).toHaveLength(2);
    expect(res.body.numbers[0]).toEqual({ phoneNumber: '+15125550001', locality: 'Austin', region: 'TX' });
  });

  it('rejects a non-3-digit area code with 400', async () => {
    restore.push(['TWILIO_ACCOUNT_SID', setEnv('TWILIO_ACCOUNT_SID', 'ACtest')]);
    restore.push(['TWILIO_AUTH_TOKEN', setEnv('TWILIO_AUTH_TOKEN', 'token')]);

    const { app } = buildApp();
    const res = await request(app).post('/api/onboarding/phone/available').send({ areaCode: '51' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_AREA_CODE');
  });

  it('returns 503 when Twilio is not configured (picker falls back to auto-pick)', async () => {
    restore.push(['TWILIO_ACCOUNT_SID', setEnv('TWILIO_ACCOUNT_SID', undefined)]);
    restore.push(['TWILIO_AUTH_TOKEN', setEnv('TWILIO_AUTH_TOKEN', undefined)]);

    const { app } = buildApp();
    const res = await request(app).post('/api/onboarding/phone/available').send({ areaCode: '512' });

    expect(res.status).toBe(503);
    expect(res.body.error).toBe('TWILIO_NOT_CONFIGURED');
  });
});

describe('POST /api/onboarding/phone/claim', () => {
  it('enqueues provisioning with the chosen number and audits the claim', async () => {
    const queue = new InMemoryQueue();
    const auditRepo = new InMemoryAuditRepository();
    const { app } = buildApp({ pool: fakePool('t0_requested'), queue, auditRepo });

    const res = await request(app)
      .post('/api/onboarding/phone/claim')
      .send({ phoneNumber: '+15125550123' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, enqueued: true, phoneNumber: '+15125550123' });

    const msg = await queue.receive<{ tenantId: string; phoneNumber?: string }>();
    expect(msg?.type).toBe(PROVISION_TWILIO_JOB_TYPE);
    expect(msg?.payload.phoneNumber).toBe('+15125550123');

    const events = auditRepo.events.filter(
      (e: { eventType: string }) => e.eventType === 'tenant.phone_number_claimed',
    );
    expect(events).toHaveLength(1);
  });

  it('rejects a non-E.164 number with 400', async () => {
    const { app } = buildApp({ pool: fakePool('t0_requested'), queue: new InMemoryQueue() });
    const res = await request(app)
      .post('/api/onboarding/phone/claim')
      .send({ phoneNumber: '512-555-0123' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_PHONE_NUMBER');
  });

  it('409s when provisioning is past the claimable state', async () => {
    const { app } = buildApp({ pool: fakePool('partial_readiness'), queue: new InMemoryQueue() });
    const res = await request(app)
      .post('/api/onboarding/phone/claim')
      .send({ phoneNumber: '+15125550123' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('PHONE_CLAIM_NOT_ALLOWED');
  });

  it('is idempotent when provisioning is already active', async () => {
    const { app } = buildApp({ pool: fakePool('full_readiness'), queue: new InMemoryQueue() });
    const res = await request(app)
      .post('/api/onboarding/phone/claim')
      .send({ phoneNumber: '+15125550123' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, skipped: true, reason: 'already_active' });
  });
});
