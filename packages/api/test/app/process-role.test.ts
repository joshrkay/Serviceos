/**
 * WS2 — PROCESS_ROLE process split.
 *
 * A PROCESS_ROLE=web deploy serves the HTTP/voice/WS surface with ZERO
 * background worker loops, so it can never be coupled to (or blocked by) the
 * sweeps + queue-drain. 'worker' and 'all' run them; unset defaults to 'all'
 * (byte-for-byte back-compat with the single-service deploy).
 *
 * These assertions read `app.backgroundIntervalCount` — the count of gated
 * background WORKER intervals (cheap observability intervals that run in every
 * role are excluded from it). createApp() is booted in in-memory mode (no
 * DATABASE_URL) so the drain resolves instantly and no Pg/Redis is required;
 * each app is drained in afterEach to clear its intervals + signal handlers.
 */
import { createHmac } from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createApp, type AppWithLifecycle } from '../../src/app';
import { resetConfig } from '../../src/shared/config';

describe('WS2 — PROCESS_ROLE process split', () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalProcessRole = process.env.PROCESS_ROLE;
  const created: AppWithLifecycle[] = [];

  const buildApp = (role: string | undefined): AppWithLifecycle => {
    if (role === undefined) {
      delete process.env.PROCESS_ROLE;
    } else {
      process.env.PROCESS_ROLE = role;
    }
    // Config is cached; reset so each build re-reads PROCESS_ROLE.
    resetConfig();
    const app = createApp();
    created.push(app);
    return app;
  };

  beforeEach(() => {
    // In-memory mode: no pool/Redis, so worker-object constructions take their
    // in-memory branches and the drain resolves without a real backend.
    delete process.env.DATABASE_URL;
  });

  afterEach(async () => {
    // Clear the intervals + SIGTERM/SIGINT handlers each createApp registered.
    for (const app of created.splice(0)) {
      await app.gracefulDrain('test-cleanup');
    }
    resetConfig();
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
    if (originalProcessRole === undefined) delete process.env.PROCESS_ROLE;
    else process.env.PROCESS_ROLE = originalProcessRole;
  });

  it('role "web" registers ZERO background worker intervals', () => {
    const app = buildApp('web');
    expect(app.backgroundIntervalCount).toBe(0);
  });

  // WS14 — 'voice' is a THIRD non-worker role: it must land in the same
  // zero-worker bucket as 'web', not fall through `!== 'web'` into running
  // background sweeps it was never meant to run.
  it('role "voice" registers ZERO background worker intervals', () => {
    const app = buildApp('voice');
    expect(app.backgroundIntervalCount).toBe(0);
  });

  it('roles "worker" and "all" register an identical, nonzero worker interval count', () => {
    const worker = buildApp('worker');
    const all = buildApp('all');
    expect(worker.backgroundIntervalCount).toBeGreaterThan(0);
    expect(all.backgroundIntervalCount).toBe(worker.backgroundIntervalCount);
  });

  it('default (PROCESS_ROLE unset) is identical to "all"', () => {
    const dflt = buildApp(undefined);
    const all = buildApp('all');
    expect(dflt.backgroundIntervalCount).toBeGreaterThan(0);
    expect(dflt.backgroundIntervalCount).toBe(all.backgroundIntervalCount);
  });

  it('role "web" still serves the HTTP surface (GET /health → 200)', async () => {
    const app = buildApp('web');
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBeDefined();
  });

  describe('WS8 — role gates the Media Streams WS upgrade handler', () => {
    // Full "media streams on" env: TWILIO_MEDIA_STREAMS_ENABLED=true alone
    // isn't enough to reach the app.listen wrap — DEEPGRAM_API_KEY must also
    // be set (streamingProvider truthy), and TTS_PROVIDER=elevenlabs +
    // ELEVENLABS_API_KEY must be set or assertTtsProviderSupportsMediaStreams
    // throws at boot (see test/shared/config.test.ts:432).
    const mediaStreamsEnvKeys = [
      'TWILIO_MEDIA_STREAMS_ENABLED',
      'TTS_PROVIDER',
      'ELEVENLABS_API_KEY',
      'DEEPGRAM_API_KEY',
      'TWILIO_AUTH_TOKEN',
      'TWILIO_DEFAULT_TENANT_ID',
      'PUBLIC_API_URL',
    ] as const;
    const originalMediaStreamsEnv: Record<string, string | undefined> = {};

    beforeEach(() => {
      for (const key of mediaStreamsEnvKeys) {
        originalMediaStreamsEnv[key] = process.env[key];
      }
      process.env.TWILIO_MEDIA_STREAMS_ENABLED = 'true';
      process.env.TTS_PROVIDER = 'elevenlabs';
      process.env.ELEVENLABS_API_KEY = 'el_test_key';
      process.env.DEEPGRAM_API_KEY = 'dg_test_key';
    });

    afterEach(() => {
      for (const key of mediaStreamsEnvKeys) {
        const original = originalMediaStreamsEnv[key];
        if (original === undefined) delete process.env[key];
        else process.env[key] = original;
      }
    });

    // app.listen is overridden (only) when mediaStreamsEnabled && role !==
    // 'worker'; the override attaches the WS upgrade listener synchronously
    // before app.listen(...) returns, so listenerCount('upgrade') on the
    // returned http.Server observes the gate directly — same surface used by
    // twilio-mediastream-server.test.ts's "feature-flag off" case.
    const listenAndCountUpgradeHandlers = (app: AppWithLifecycle): Promise<number> =>
      new Promise((resolve, reject) => {
        const server = app.listen(0, () => {
          const count = server.listenerCount('upgrade');
          server.close(() => resolve(count));
        });
        server.on('error', reject);
      });

    it('role "worker" does NOT attach the WS upgrade handler', async () => {
      const app = buildApp('worker');
      const count = await listenAndCountUpgradeHandlers(app);
      expect(count).toBe(0);
    });

    it('role "web" still attaches the WS upgrade handler (unchanged)', async () => {
      const app = buildApp('web');
      const count = await listenAndCountUpgradeHandlers(app);
      expect(count).toBeGreaterThan(0);
    });

    it('role "all" still attaches the WS upgrade handler (unchanged)', async () => {
      const app = buildApp('all');
      const count = await listenAndCountUpgradeHandlers(app);
      expect(count).toBeGreaterThan(0);
    });

    // WS14 — the dedicated voice service attaches the WS exactly like 'web'
    // does; only 'worker' is excluded from this gate.
    it('role "voice" attaches the WS upgrade handler', async () => {
      const app = buildApp('voice');
      const count = await listenAndCountUpgradeHandlers(app);
      expect(count).toBeGreaterThan(0);
    });

    // The /voice branch must agree with the WS attach gate: a worker never
    // serves the stream socket, so its TwiML must never point Twilio at it.
    const signedVoicePost = (app: AppWithLifecycle) => {
      const url = 'http://localhost:3101/api/telephony/voice';
      const params = { CallSid: 'CArole1', From: '+15005550006', To: '+15550001111' };
      const data =
        url + Object.keys(params).sort().map((k) => k + params[k as keyof typeof params]).join('');
      const signature = createHmac('sha1', process.env.TWILIO_AUTH_TOKEN as string)
        .update(Buffer.from(data, 'utf-8'))
        .digest('base64');
      return request(app)
        .post('/api/telephony/voice')
        .set('x-twilio-signature', signature)
        .type('form')
        .send(params);
    };

    it('role "worker" /voice degrades to Gather — never <Stream> at a socket this process rejects', async () => {
      process.env.TWILIO_AUTH_TOKEN = 'testtoken123';
      process.env.TWILIO_DEFAULT_TENANT_ID = '11111111-1111-4111-8111-111111111111';
      process.env.PUBLIC_API_URL = 'http://localhost:3101';
      const app = buildApp('worker');
      const res = await signedVoicePost(app);
      expect(res.status).toBe(200);
      expect(res.text).not.toContain('<Stream');
      expect(res.text).toContain('<Gather');
    });

    it('role "all" /voice still emits <Connect><Stream/> (unchanged)', async () => {
      process.env.TWILIO_AUTH_TOKEN = 'testtoken123';
      process.env.TWILIO_DEFAULT_TENANT_ID = '11111111-1111-4111-8111-111111111111';
      process.env.PUBLIC_API_URL = 'http://localhost:3101';
      const app = buildApp('all');
      const res = await signedVoicePost(app);
      expect(res.status).toBe(200);
      expect(res.text).toContain('<Connect><Stream');
    });

    // WS14 — the dedicated voice service is the intended home for live
    // media-streams calls in the three-service topology: it must emit
    // <Connect><Stream/> exactly like 'web'/'all' do, never degrade to
    // Gather the way a worker-role process does.
    it('role "voice" /voice emits <Connect><Stream/>', async () => {
      process.env.TWILIO_AUTH_TOKEN = 'testtoken123';
      process.env.TWILIO_DEFAULT_TENANT_ID = '11111111-1111-4111-8111-111111111111';
      process.env.PUBLIC_API_URL = 'http://localhost:3101';
      const app = buildApp('voice');
      const res = await signedVoicePost(app);
      expect(res.status).toBe(200);
      expect(res.text).toContain('<Connect><Stream');
    });
  });

  describe('WS15 — SLO monitor is a role-gated worker interval', () => {
    // The count invariants above already prove NO worker interval (this one
    // included) runs in web role; this pins that the SLO monitor specifically
    // is one of them — registered inside its shouldRunWorkers block and driven
    // through the leader lock — so a refactor can't quietly move it into the
    // ungated observability baseline (where web replicas would page).
    it('is registered under shouldRunWorkers + the sloMonitor leader lock (source-level)', () => {
      const { readFileSync } = require('node:fs') as typeof import('node:fs');
      const { resolve: resolvePath } = require('node:path') as typeof import('node:path');
      const appSrc = readFileSync(resolvePath(__dirname, '../../src/app.ts'), 'utf8');
      // The registration segment: from the WS15 worker-gate comment block's
      // `if (shouldRunWorkers)` to the interval registration.
      const segment = appSrc.match(
        /\/\/ WS15 — platform SLO monitor\.[\s\S]*?SLO_MONITOR_INTERVAL_MS\)\);/,
      );
      expect(segment).not.toBeNull();
      expect(segment![0]).toContain('if (shouldRunWorkers) {');
      expect(segment![0]).toContain('runAsLeader(SWEEP_LOCK.sloMonitor');
      expect(segment![0]).toContain('runSloMonitor(');
      // Gate comes before the registration inside the segment.
      expect(segment![0].indexOf('if (shouldRunWorkers) {')).toBeLessThan(
        segment![0].indexOf('registerInterval('),
      );
    });
  });
});
