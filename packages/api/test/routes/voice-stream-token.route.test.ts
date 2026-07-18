/**
 * UB-B1 — stream-token mint hardening.
 *
 * Conversation mode mints a Deepgram grant token per session start, far more
 * often than PTT dictation, and until this unit the endpoint was covered only
 * by the global /api per-tenant limiter (1000 req/min) with zero audit trail.
 * Pins:
 *   - a dedicated, configurable per-tenant mint limiter
 *     (VOICE_STREAM_TOKEN_MINTS_PER_MIN) that answers 429 with the standard
 *     JSON error envelope,
 *   - the limiter is keyed per tenant, not global,
 *   - every successful mint emits a `voice.stream_token_minted` audit event.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { AuthenticatedRequest } from '../../src/auth/clerk';
import { createVoiceRouter } from '../../src/routes/voice';
import { InMemoryVoiceRepository } from '../../src/voice/voice-service';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import type { Queue } from '../../src/queues/queue';

const TENANT_A = 'aaaa1111-e5f6-7890-abcd-ef1234567890';
const TENANT_B = 'bbbb2222-e5f6-7890-abcd-ef1234567890';

function makeQueue(): Queue {
  return { send: vi.fn(async () => 'queued-1') } as unknown as Queue;
}

/**
 * The auth stub reads the tenant from an `x-test-tenant` header so a single
 * app instance (single limiter store) can be exercised by multiple tenants.
 */
function buildApp(auditRepo?: InMemoryAuditRepository) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = {
      userId: 'user-1',
      sessionId: 'sess-1',
      tenantId: (req.headers['x-test-tenant'] as string) || TENANT_A,
      role: 'owner',
    } as AuthenticatedRequest['auth'];
    next();
  });
  app.use(
    '/api/voice',
    createVoiceRouter(new InMemoryVoiceRepository(), makeQueue(), undefined, auditRepo),
  );
  return app;
}

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv.DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
  savedEnv.VOICE_STREAM_TOKEN_MINTS_PER_MIN = process.env.VOICE_STREAM_TOKEN_MINTS_PER_MIN;
  savedEnv.REDIS_URL = process.env.REDIS_URL;
  process.env.DEEPGRAM_API_KEY = 'dg-key-test';
  delete process.env.REDIS_URL; // limiter uses a fresh per-app MemoryStore
  // Deepgram's /v1/auth/grant — never hit for real in unit tests.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new global.Response(JSON.stringify({ access_token: 'dg-temp-token', expires_in: 30 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('UB-B1 — POST /api/voice/stream-token mint hardening', () => {
  it('mints a token and emits a voice.stream_token_minted audit event', async () => {
    const auditRepo = new InMemoryAuditRepository();
    const app = buildApp(auditRepo);

    const res = await request(app).post('/api/voice/stream-token');

    expect(res.status).toBe(200);
    expect(res.body.token).toBe('dg-temp-token');
    expect(res.body.model).toBe('nova-3');

    const events = auditRepo.getAll();
    expect(events.map((e) => e.eventType)).toContain('voice.stream_token_minted');
    const mint = events.find((e) => e.eventType === 'voice.stream_token_minted')!;
    expect(mint.tenantId).toBe(TENANT_A);
    expect(mint.actorId).toBe('user-1');
    expect(mint.metadata).toMatchObject({ model: 'nova-3', expiresInSeconds: 30 });
  });

  it('A2: threads a valid ?language= query param onto the mint audit metadata', async () => {
    const auditRepo = new InMemoryAuditRepository();
    const app = buildApp(auditRepo);

    const res = await request(app).post('/api/voice/stream-token?language=es');

    expect(res.status).toBe(200);
    const mint = auditRepo.getAll().find((e) => e.eventType === 'voice.stream_token_minted')!;
    expect(mint.metadata).toMatchObject({ language: 'es' });
  });

  it('A2: ignores an invalid ?language= value (never blocks the mint, no bogus language in the audit)', async () => {
    const auditRepo = new InMemoryAuditRepository();
    const app = buildApp(auditRepo);

    const res = await request(app).post('/api/voice/stream-token?language=fr');

    expect(res.status).toBe(200);
    const mint = auditRepo.getAll().find((e) => e.eventType === 'voice.stream_token_minted')!;
    expect(mint.metadata).not.toHaveProperty('language');
  });

  it('A2: omits language from the audit metadata when no query param is sent (zero behavior change)', async () => {
    const auditRepo = new InMemoryAuditRepository();
    const app = buildApp(auditRepo);

    await request(app).post('/api/voice/stream-token');

    const mint = auditRepo.getAll().find((e) => e.eventType === 'voice.stream_token_minted')!;
    expect(mint.metadata).not.toHaveProperty('language');
  });

  it('enforces the configurable per-tenant mint limit with a 429 JSON envelope', async () => {
    process.env.VOICE_STREAM_TOKEN_MINTS_PER_MIN = '2';
    const app = buildApp();

    expect((await request(app).post('/api/voice/stream-token')).status).toBe(200);
    expect((await request(app).post('/api/voice/stream-token')).status).toBe(200);

    const limited = await request(app).post('/api/voice/stream-token');
    expect(limited.status).toBe(429);
    // Standard JSON error envelope — not express-rate-limit's plain-text default.
    expect(limited.body).toMatchObject({
      error: 'RATE_LIMITED',
      message: expect.stringMatching(/try again/i),
    });
  });

  it('limits per tenant, not globally: one tenant at its cap does not starve another', async () => {
    process.env.VOICE_STREAM_TOKEN_MINTS_PER_MIN = '2';
    const auditRepo = new InMemoryAuditRepository();
    const app = buildApp(auditRepo);

    // Tenant A exhausts its bucket.
    await request(app).post('/api/voice/stream-token').set('x-test-tenant', TENANT_A);
    await request(app).post('/api/voice/stream-token').set('x-test-tenant', TENANT_A);
    const aLimited = await request(app)
      .post('/api/voice/stream-token')
      .set('x-test-tenant', TENANT_A);
    expect(aLimited.status).toBe(429);

    // Tenant B still mints (and its mint is audited to ITS tenant).
    const bOk = await request(app)
      .post('/api/voice/stream-token')
      .set('x-test-tenant', TENANT_B);
    expect(bOk.status).toBe(200);
    const bMints = auditRepo
      .getAll()
      .filter((e) => e.eventType === 'voice.stream_token_minted' && e.tenantId === TENANT_B);
    expect(bMints).toHaveLength(1);
  });

  it('emits a voice.stream_token_mint_failed audit event when minting fails (503 not-configured)', async () => {
    delete process.env.DEEPGRAM_API_KEY;
    const auditRepo = new InMemoryAuditRepository();
    const app = buildApp(auditRepo);

    const res = await request(app).post('/api/voice/stream-token');
    expect(res.status).toBe(503);

    const events = auditRepo.getAll();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: 'voice.stream_token_mint_failed',
      tenantId: TENANT_A,
      actorId: 'user-1',
      metadata: { reason: 'not_configured' },
    });
  });

  it('returns 503 (not a retryable 502) when Deepgram rejects the key as non-Member', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new global.Response(
          JSON.stringify({ err_code: 'FORBIDDEN', err_msg: 'Insufficient permissions.' }),
          { status: 403, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    const auditRepo = new InMemoryAuditRepository();
    const app = buildApp(auditRepo);

    const res = await request(app).post('/api/voice/stream-token');
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({
      error: 'NOT_CONFIGURED',
      message: expect.stringMatching(/Member permissions/i),
    });

    const events = auditRepo.getAll();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: 'voice.stream_token_mint_failed',
      metadata: { reason: 'permission_denied' },
    });
  });

  it('emits a voice.stream_token_mint_failed audit event on a generic mint failure (502)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('ECONNRESET');
    }));
    const auditRepo = new InMemoryAuditRepository();
    const app = buildApp(auditRepo);

    const res = await request(app).post('/api/voice/stream-token');
    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ error: 'TOKEN_MINT_FAILED' });

    const events = auditRepo.getAll();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: 'voice.stream_token_mint_failed',
      metadata: { reason: 'provider_error' },
    });
  });

  it('does not fail the mint when the audit write itself throws, and logs the failure', async () => {
    const auditRepo = new InMemoryAuditRepository();
    vi.spyOn(auditRepo, 'create').mockRejectedValueOnce(new Error('audit db down'));
    const warn = vi.fn();
    const logger = {
      debug: vi.fn(), info: vi.fn(), warn, error: vi.fn(),
      child: vi.fn(() => logger),
    };
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = {
        userId: 'user-1',
        sessionId: 'sess-1',
        tenantId: TENANT_A,
        role: 'owner',
      } as AuthenticatedRequest['auth'];
      next();
    });
    app.use(
      '/api/voice',
      createVoiceRouter(new InMemoryVoiceRepository(), makeQueue(), undefined, auditRepo, logger),
    );

    const res = await request(app).post('/api/voice/stream-token');

    // The mint itself still succeeds — an audit-write failure is non-fatal.
    expect(res.status).toBe(200);
    expect(res.body.token).toBe('dg-temp-token');

    // But the audit failure is observable via a warn-level log, not silently
    // swallowed.
    expect(warn).toHaveBeenCalledWith(
      'voice.stream-token: audit write failed',
      expect.objectContaining({
        route: 'POST /api/voice/stream-token',
        tenantId: TENANT_A,
        eventType: 'voice.stream_token_minted',
        error: 'audit db down',
      }),
    );
  });
});
