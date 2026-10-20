/**
 * Voice realtime concurrency self-check (U1 — voice-parity plan).
 *
 * Mirrors mixed-1000-selfcheck.ts: spins up an in-process stub WebSocket
 * server that speaks just enough Twilio Media Streams protocol —
 *
 *   - accepts `connected` / `start` / `media` frames silently;
 *   - on a `mark` named `eot-*` (the emulator's end-of-turn), replies after
 *     ~50 ms with one outbound `media` frame (160 bytes of μ-law silence) and
 *     a server `mark`, so TTFA is measurable and the ack path is exercised;
 *   - on the `/silent` path it never replies, so the no-reply accounting is
 *     exercised too —
 *
 * then runs the driver at tiny scale (N = 1 → 2, one turn per stream, 2 s hold
 * cap) three times and asserts the report: a passing sweep, a sweep whose
 * threshold every level breaches (trigger null, early stop), and a silent
 * target (no sample, nothing thrown). Proves the TOOLING (emulator import
 * chain, sweep, percentiles, stop rule, report) without booting the API —
 * runs in CI with no docker or network, in well under 15 s.
 *
 * Exit 0 on a healthy run, non-zero on any harness defect.
 *
 * Run: tsx loadtest/voice-realtime-concurrency-selfcheck.ts
 */

import { WebSocketServer, type WebSocket } from 'ws';
import {
  DEFAULT_OPTIONS,
  runVoiceConcurrency,
  summaryLine,
  type VoiceConcurrencyOptions,
  type VoiceConcurrencyReport,
} from './voice-realtime-concurrency';

/** 20 ms of μ-law silence (0xFF is μ-law zero). */
const SILENT_FRAME = Buffer.alloc(160, 0xff).toString('base64');

function startStubServer(): Promise<{ wss: WebSocketServer; url: string }> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  let turnCounter = 0;
  wss.on('connection', (ws: WebSocket, req) => {
    const silent = (req.url ?? '').startsWith('/silent');
    let streamSid = '';
    ws.on('message', (raw) => {
      let msg: { event?: string; streamSid?: string; mark?: { name?: string } };
      try {
        msg = JSON.parse(raw.toString()) as typeof msg;
      } catch {
        return;
      }
      if (msg.event === 'start' && typeof msg.streamSid === 'string') streamSid = msg.streamSid;
      if (msg.event === 'mark' && msg.mark?.name?.startsWith('eot-') && !silent) {
        // 40–80 ms so the percentiles are not all one number.
        const delay = 40 + (turnCounter++ % 5) * 10;
        setTimeout(() => {
          if (ws.readyState !== ws.OPEN) return;
          ws.send(JSON.stringify({ event: 'media', streamSid, media: { payload: SILENT_FRAME } }));
          ws.send(JSON.stringify({ event: 'mark', streamSid, mark: { name: `reply-${turnCounter}` } }));
        }, delay);
      }
    });
    ws.on('error', () => {});
  });
  return new Promise((resolve, reject) => {
    wss.once('error', reject);
    wss.once('listening', () => {
      const addr = wss.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('failed to bind stub server'));
        return;
      }
      resolve({ wss, url: `ws://127.0.0.1:${addr.port}/api/telephony/stream` });
    });
  });
}

async function main(): Promise<void> {
  const t0 = Date.now();
  const { wss, url } = await startStubServer();

  const tiny: VoiceConcurrencyOptions = {
    ...DEFAULT_OPTIONS,
    url,
    start: 1,
    step: 1,
    max: 2,
    turns: 1,
    holdSeconds: 2,
    pauseMs: 50,
    replyTimeoutMs: 1500,
    silenceWindowMs: 100,
    staggerMs: 5,
    callSidPrefix: 'CA_SELFCHECK_',
    out: undefined,
  };

  let passing: VoiceConcurrencyReport;
  let breaching: VoiceConcurrencyReport;
  let silent: VoiceConcurrencyReport;
  try {
    passing = await runVoiceConcurrency(tiny);
    breaching = await runVoiceConcurrency({ ...tiny, thresholdMs: 1 });
    silent = await runVoiceConcurrency({
      ...tiny,
      url: url.replace('/api/telephony/stream', '/silent'),
      replyTimeoutMs: 300,
    });
  } finally {
    for (const client of wss.clients) client.terminate();
    wss.close();
  }
  const elapsedMs = Date.now() - t0;

  const [p1, p2] = passing.levels;
  const inRange = (row: (typeof passing.levels)[number]): boolean =>
    row.ttfaMs !== null && row.ttfaMs.p50 >= 30 && row.ttfaMs.p95 <= 500 && row.ttfaMs.p99 >= row.ttfaMs.p50;

  const checks: Array<[string, boolean]> = [
    ['passing: ran N=1 and N=2', passing.levels.length === 2 && p1?.concurrency === 1 && p2?.concurrency === 2],
    ['passing: every stream opened', p1?.streamsOpened === 1 && p2?.streamsOpened === 2],
    ['passing: one TTFA sample per stream', p1?.samples === 1 && p2?.samples === 2],
    ['passing: TTFA ≈ stub delay (30–500 ms)', inRange(p1) && inRange(p2)],
    ['passing: zero errors / noReply / drops', passing.levels.every((l) => l.errors === 0 && l.noReply === 0 && l.streamsDropped === 0)],
    ['passing: no breach, trigger = max', passing.firstBreachAt === null && passing.replicaTrigger === 2 && passing.stoppedBecause === 'max_reached'],
    ['passing: stand-in tone recorded in report', passing.fixture.source === 'synthetic-tone-440hz' && typeof passing.fixture.note === 'string'],
    ['breaching: first level breached → trigger null', breaching.firstBreachAt === 1 && breaching.replicaTrigger === null],
    ['breaching: stopped after two consecutive breaches', breaching.stoppedBecause === 'two_consecutive_breaches' && breaching.levels.length === 2],
    ['silent: no sample, noReply counted, nothing thrown', silent.levels.every((l) => l.samples === 0 && l.ttfaMs === null && l.noReply === l.concurrency && l.breached)],
    ['silent: trigger null, early stop', silent.replicaTrigger === null && silent.firstBreachAt === 1 && silent.stoppedBecause === 'two_consecutive_breaches'],
    ['finished in < 15 s', elapsedMs < 15_000],
  ];

  const failed = checks.filter(([, ok]) => !ok);
  process.stdout.write(
    `\nvoice realtime concurrency self-check against ${url}\n` +
      checks.map(([name, ok]) => `  ${ok ? '✓' : '✗'} ${name}`).join('\n') +
      `\n\n  passing:   ${summaryLine(passing)}\n` +
      `  breaching: ${summaryLine(breaching)}\n` +
      `  silent:    ${summaryLine(silent)}\n` +
      `  ${(elapsedMs / 1000).toFixed(1)} s wall clock\n`,
  );

  if (failed.length > 0) {
    process.stderr.write(`\nself-check FAILED: ${failed.map(([n]) => n).join(', ')}\n`);
    process.exit(1);
  }
  process.stdout.write('\nself-check PASSED — voice realtime concurrency driver + report pipeline operational.\n');
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`self-check crashed: ${err?.stack ?? err}\n`);
  process.exit(1);
});
