#!/usr/bin/env tsx
/**
 * §11 H5 — voice-path load test.
 *
 * Ramps from 1 to N concurrent Twilio Media Streams WebSocket connections
 * against a configurable endpoint, holds for a configurable duration, and
 * outputs a JSON report with p50/p95/p99 across connection latency, first-
 * STT latency, and drop rate.
 *
 * Run ad-hoc against staging once before opening self-serve, and again when
 * voice provider or instance size changes. Not in CI (see
 * docs/runbooks/voice-capacity.md).
 *
 * Usage:
 *   STAGING_WS_URL=wss://api.staging.serviceos.com/api/telephony/stream \
 *     npx tsx packages/api/scripts/voice-load-test.ts --max 50 --ramp 60 --hold 300
 */
import { WebSocket } from 'ws';
import { performance } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';

interface ConnMetrics {
  connectMs: number;
  firstSttMs?: number;
  dropped: boolean;
  err?: string;
}

function parseArgs(): { max: number; rampSec: number; holdSec: number; out: string } {
  const argv = process.argv.slice(2);
  const arg = (k: string, d: number): number => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 ? Number(argv[i + 1]) : d;
  };
  return {
    max: arg('max', 50),
    rampSec: arg('ramp', 60),
    holdSec: arg('hold', 300),
    out: 'voice-load-report.json',
  };
}

function generateMulawChunk(): Buffer {
  // 20ms of 8kHz mulaw — 160 bytes. Sine wave at 440 Hz, byte-rate-accurate.
  const buf = Buffer.alloc(160);
  for (let i = 0; i < 160; i++) {
    const sample = Math.sin((2 * Math.PI * 440 * i) / 8000);
    buf[i] = Math.floor((sample + 1) * 127);
  }
  return buf;
}

async function runOne(url: string): Promise<ConnMetrics> {
  const t0 = performance.now();
  const ws = new WebSocket(url, { perMessageDeflate: false });
  const metrics: ConnMetrics = { connectMs: 0, dropped: false };

  try {
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', (e) => reject(e));
      setTimeout(() => reject(new Error('connect timeout')), 10_000);
    });
    metrics.connectMs = performance.now() - t0;

    ws.send(JSON.stringify({ event: 'start', start: { streamSid: `load-${Date.now()}` } }));

    let firstReply: number | undefined;
    ws.on('message', () => {
      if (firstReply === undefined) firstReply = performance.now();
    });

    // Stream 5s of audio at 50 chunks/sec
    for (let i = 0; i < 250; i++) {
      ws.send(JSON.stringify({ event: 'media', media: { payload: generateMulawChunk().toString('base64') } }));
      await new Promise((r) => setTimeout(r, 20));
    }
    ws.send(JSON.stringify({ event: 'stop' }));

    if (firstReply !== undefined) metrics.firstSttMs = firstReply - t0;
    ws.close();
    return metrics;
  } catch (e: unknown) {
    metrics.dropped = true;
    metrics.err = e instanceof Error ? e.message : String(e);
    return metrics;
  }
}

function pct(arr: number[], p: number): number {
  if (arr.length === 0) return NaN;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

async function main(): Promise<void> {
  const { max, rampSec, holdSec, out } = parseArgs();
  const url = process.env.STAGING_WS_URL;
  if (!url) throw new Error('STAGING_WS_URL is required');

  console.log(`load test: ramping to ${max} conns over ${rampSec}s, holding ${holdSec}s`);
  const results: ConnMetrics[] = [];
  const active = new Set<Promise<void>>();
  const start = Date.now();

  while (Date.now() - start < (rampSec + holdSec) * 1000) {
    const elapsed = (Date.now() - start) / 1000;
    const target = elapsed < rampSec ? Math.ceil((elapsed / rampSec) * max) : max;
    while (active.size < target) {
      const p = runOne(url)
        .then((m) => { results.push(m); })
        .finally(() => active.delete(p));
      active.add(p);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  await Promise.allSettled([...active]);

  const ct = results.filter((r) => !r.dropped).map((r) => r.connectMs);
  const st = results.filter((r) => r.firstSttMs !== undefined).map((r) => r.firstSttMs as number);
  const report = {
    totalConnections: results.length,
    droppedConnections: results.filter((r) => r.dropped).length,
    connectMs: { p50: pct(ct, 0.5), p95: pct(ct, 0.95), p99: pct(ct, 0.99) },
    firstSttMs: { p50: pct(st, 0.5), p95: pct(st, 0.95), p99: pct(st, 0.99) },
  };

  writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(`report written to ${out}`);
  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
