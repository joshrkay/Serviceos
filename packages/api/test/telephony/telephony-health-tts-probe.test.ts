/**
 * #1536 — GET /api/telephony/health must report whether the configured TTS
 * provider can actually speak, not just whether a key is set. A key without
 * the Text to Speech permission reported `tts: true` while every phone reply
 * failed. Seam: the health route (supertest) with a stub TTS provider probe.
 */
import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createTelephonyRouter, type TelephonyHealthReport } from '../../src/routes/telephony';
import type { TwilioGatherAdapter } from '../../src/telephony/twilio-adapter';
import { createTtsHealthCheck } from '../../src/ai/tts/tts-health';
import type { TtsProbeResult, TtsProvider } from '../../src/ai/tts/tts-provider';

const configOnlyReport = (): TelephonyHealthReport => ({
  ok: true,
  capabilities: {
    mediaStreams: true,
    tts: true,
    stt: true,
    recording: true,
    messageDelivery: true,
    database: true,
    llmGateway: true,
  },
  config: { publicBaseUrl: 'https://api.invalid', businessName: 'Test Co' },
  warnings: [],
});

function stubProvider(probe: () => Promise<TtsProbeResult>): TtsProvider & { probeCalls: number } {
  const p = {
    probeCalls: 0,
    synthesize: async () => {
      throw new Error('health must not synthesize through the reply path');
    },
    probe: async () => {
      p.probeCalls += 1;
      return probe();
    },
  };
  return p;
}

function appWith(
  provider: TtsProvider,
  opts: {
    ttlMs?: number;
    responseDeadlineMs?: number;
    probeTimeoutMs?: number;
    now?: () => number;
    report?: () => TelephonyHealthReport;
  } = {},
) {
  const app = express();
  app.use(
    '/api/telephony',
    createTelephonyRouter({
      adapter: {} as TwilioGatherAdapter,
      authTokenGetter: () => 'unused',
      resolveTenantId: () => undefined,
      getHealth: opts.report ?? configOnlyReport,
      ttsHealth: createTtsHealthCheck({ provider, ...opts }),
    }),
  );
  return app;
}

describe('#1536 — /api/telephony/health probes the TTS provider', () => {
  it('reports tts:false with reason missing_permissions when the key cannot synthesize', async () => {
    const provider = stubProvider(async () => ({ ok: false, reason: 'missing_permissions' }));

    const res = await request(appWith(provider)).get('/api/telephony/health');

    expect(res.status).toBe(200);
    expect(res.body.capabilities.tts).toBe(false);
    expect(res.body.ttsCheck).toMatchObject({ status: 'failed', reason: 'missing_permissions' });
    // Calls still work: /voice routes them to Gather (Twilio <Say>) on a
    // credential failure (#1537 gate a2), so the line is degraded, not down —
    // and a key permission must not fail every deploy's smoke check.
    expect(res.body.ok).toBe(true);
    expect(res.body.degraded).toBe(true);
    expect(res.body.warnings).toContain(
      'TTS key rejected (missing_permissions) — calls fall back to Gather (Twilio <Say>)',
    );
  });

  it('a billing refusal (payment_required) is degraded, not down: calls fall back to Gather', async () => {
    const provider = stubProvider(async () => ({ ok: false, reason: 'payment_required' }));

    const res = await request(appWith(provider)).get('/api/telephony/health');

    expect(res.body.capabilities.tts).toBe(false);
    expect(res.body.ok).toBe(true);
    expect(res.body.degraded).toBe(true);
  });

  it('a credential failure does not mask a hard failure: no database → ok:false', async () => {
    const provider = stubProvider(async () => ({ ok: false, reason: 'unauthorized' }));
    const base = configOnlyReport();
    const report: TelephonyHealthReport = {
      ...base,
      ok: false,
      capabilities: { ...base.capabilities, database: false },
    };

    const res = await request(appWith(provider, { report: () => report })).get('/api/telephony/health');

    expect(res.body.ok).toBe(false);
    expect(res.body.degraded).toBe(true);
    expect(res.body.capabilities.tts).toBe(false);
  });

  it('a verified key → ok:true and not degraded', async () => {
    const res = await request(appWith(stubProvider(async () => ({ ok: true })))).get('/api/telephony/health');

    expect(res.body.ok).toBe(true);
    expect(res.body.degraded).toBeUndefined();
    expect(res.body.capabilities.tts).toBe(true);
  });

  it('a non-credential failure (unreachable) still reports ok:false, as before — no Gather fallback covers it', async () => {
    const provider = stubProvider(async () => ({ ok: false, reason: 'unreachable' }));

    const res = await request(appWith(provider)).get('/api/telephony/health');

    expect(res.body.ok).toBe(false);
    expect(res.body.capabilities.tts).toBe(false);
  });

  it('caches the verdict: repeated health hits within the TTL probe the provider once, then re-probe after it', async () => {
    let clock = 1_000_000;
    const provider = stubProvider(async () => ({ ok: true }));
    const app = appWith(provider, { ttlMs: 10 * 60_000, now: () => clock });

    const first = await request(app).get('/api/telephony/health');
    await request(app).get('/api/telephony/health');
    clock += 9 * 60_000;
    await request(app).get('/api/telephony/health');

    expect(first.body.capabilities.tts).toBe(true);
    expect(first.body.ttsCheck).toMatchObject({ status: 'ok' });
    expect(provider.probeCalls).toBe(1);

    clock += 2 * 60_000; // 11 minutes since the probe — past the 10 min TTL
    await request(app).get('/api/telephony/health');
    expect(provider.probeCalls).toBe(2);
  });

  it('never blocks on a slow provider: answers promptly with ttsCheck unknown while the probe runs', async () => {
    const provider = stubProvider(() => new Promise<TtsProbeResult>(() => {})); // hangs forever
    const app = appWith(provider, { responseDeadlineMs: 20, probeTimeoutMs: 60_000 });

    const started = Date.now();
    const res = await request(app).get('/api/telephony/health');

    expect(Date.now() - started).toBeLessThan(1_000);
    expect(res.status).toBe(200);
    expect(res.body.ttsCheck).toMatchObject({ status: 'unknown' });
    expect(res.body.capabilities.tts).toBe(true); // no verdict yet — config answer stands
  });

  it('a probe that never answers is cached as unreachable and reported tts:false on the next hit', async () => {
    const provider = stubProvider(() => new Promise<TtsProbeResult>(() => {}));
    const app = appWith(provider, { responseDeadlineMs: 5, probeTimeoutMs: 30 });

    await request(app).get('/api/telephony/health');
    await new Promise((r) => setTimeout(r, 60));
    const res = await request(app).get('/api/telephony/health');

    expect(res.body.ttsCheck).toMatchObject({ status: 'failed', reason: 'unreachable' });
    expect(res.body.capabilities.tts).toBe(false);
    expect(provider.probeCalls).toBe(1);
  });

  it('a provider without a probe stays config-only and is marked as such', async () => {
    const provider: TtsProvider = {
      synthesize: async () => {
        throw new Error('unused');
      },
    };

    const res = await request(appWith(provider)).get('/api/telephony/health');

    expect(res.body.capabilities.tts).toBe(true);
    expect(res.body.ttsCheck).toEqual({ status: 'config_only' });
  });
});
