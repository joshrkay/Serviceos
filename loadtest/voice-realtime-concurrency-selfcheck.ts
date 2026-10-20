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
 * target (no sample, nothing thrown). Two more sweeps pin how the capacity result
 * is derived from the CONFIRMED breach pair: the stub delays by level (parsed
 * from the CallSid), so breach/pass/breach/breach at N=3/5/7/9 must report
 * firstBreachAt=7 / replicaTrigger=5, and an isolated breach followed by
 * passes through max must report firstBreachAt=null / replicaTrigger=top
 * passing level. Two late-reply sweeps pin the stale-frame rule: turn 1's reply lands after
 * the reply timeout, during turn 2's caller fixture; turn 1 must be `noReply`, and turn 2 is
 * a sample only if it gets its own post-transcript frame (never a 0 ms sample from the stale
 * frame). Proves the TOOLING (emulator import
 * chain, sweep, percentiles, stop rule, report) without booting the API —
 * runs in CI with no docker or network, in well under 30 s.
 *
 * Exit 0 on a healthy run, non-zero on any harness defect.
 *
 * Run: tsx loadtest/voice-realtime-concurrency-selfcheck.ts
 */

import { WebSocketServer, type WebSocket } from 'ws';
import {
  DEFAULT_OPTIONS,
  formatLevel,
  runVoiceConcurrency,
  summaryLine,
  type VoiceConcurrencyOptions,
  type VoiceConcurrencyReport,
} from './voice-realtime-concurrency';

/** 20 ms of μ-law silence (0xFF is μ-law zero). */
const SILENT_FRAME = Buffer.alloc(160, 0xff).toString('base64');

/** Per-level reply delay (ms) for the level-shaped scenarios, selected by URL path; default 40–80 ms. */
type LevelDelay = (concurrency: number) => number;

/** Per-eot-index reply delay (ms) for the late-reply scenarios, selected by URL path. */
type TurnDelay = (turnIndex: number) => number;

function startStubServer(): Promise<{
  wss: WebSocketServer;
  url: string;
  levelDelays: Map<string, LevelDelay>;
  turnDelays: Map<string, TurnDelay>;
}> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  let turnCounter = 0;
  const levelDelays = new Map<string, LevelDelay>();
  const turnDelays = new Map<string, TurnDelay>();
  wss.on('connection', (ws: WebSocket, req) => {
    const silent = (req.url ?? '').startsWith('/silent');
    let streamSid = '';
    let level: number | null = null;
    const levelDelay = levelDelays.get(req.url ?? '') ?? null;
    const turnDelay = turnDelays.get(req.url ?? '') ?? null;
    let eotCount = 0;
    ws.on('message', (raw) => {
      let msg: { event?: string; streamSid?: string; start?: { callSid?: string }; mark?: { name?: string } };
      try {
        msg = JSON.parse(raw.toString()) as typeof msg;
      } catch {
        return;
      }
      if (msg.event === 'start' && typeof msg.streamSid === 'string') streamSid = msg.streamSid;
      // CallSid is `<prefix><N>_<i>` — recover the sweep level N.
      if (msg.event === 'start') level = Number(/_(\d+)_\d+$/.exec(msg.start?.callSid ?? '')?.[1] ?? NaN);
      if (msg.event === 'mark' && msg.mark?.name?.startsWith('eot-') && !silent) {
        // 40–80 ms so the percentiles are not all one number.
        const eotIndex = eotCount++;
        const delay = turnDelay
          ? turnDelay(eotIndex)
          : levelDelay && level !== null && Number.isFinite(level)
            ? levelDelay(level)
            : 40 + (turnCounter++ % 5) * 10;
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
      resolve({
        wss,
        url: `ws://127.0.0.1:${addr.port}/api/telephony/stream`,
        levelDelays,
        turnDelays,
      });
    });
  });
}

async function main(): Promise<void> {
  const t0 = Date.now();
  const { wss, url, levelDelays, turnDelays } = await startStubServer();

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
  let confirmedPair: VoiceConcurrencyReport;
  let isolated: VoiceConcurrencyReport;
  // Threshold 150 ms sits between the fast (40 ms) and slow (300 ms) stub delays.
  const shaped: VoiceConcurrencyOptions = { ...tiny, start: 3, step: 2, max: 9, thresholdMs: 150 };
  // Each shaped scenario has its own URL path so the two sweeps can run in parallel.
  levelDelays.set('/pair', (n) => (n === 5 ? 40 : 300)); // breach / pass / breach / breach at N = 3 / 5 / 7 / 9
  levelDelays.set('/isolated', (n) => (n === 5 ? 300 : 40)); // isolated breach at N=5, then pass through max
  // Late-reply scenarios (2 turns, 300 ms reply timeout, 1.5 s caller fixture): turn 1's reply
  // arrives 1000 ms after its eot — after the timeout, while turn 2's fixture is still streaming.
  // /late-recovers: turn 2 then replies promptly (own frame, ~100 ms).
  // /late-stale: turn 2 never replies in time, so the stale frame is the only one the emulator holds.
  turnDelays.set('/late-recovers', (i) => (i === 0 ? 1000 : 100));
  turnDelays.set('/late-stale', (i) => (i === 0 ? 1000 : 6000));
  const late: VoiceConcurrencyOptions = {
    ...tiny,
    start: 1,
    max: 1,
    turns: 2,
    holdSeconds: 10,
    replyTimeoutMs: 300,
    callSidPrefix: 'CA_SELFCHECK_LATE_',
  };
  let lateRecovers: VoiceConcurrencyReport;
  let lateStale: VoiceConcurrencyReport;
  try {
    passing = await runVoiceConcurrency(tiny);
    breaching = await runVoiceConcurrency({ ...tiny, thresholdMs: 1 });
    silent = await runVoiceConcurrency({
      ...tiny,
      url: url.replace('/api/telephony/stream', '/silent'),
      replyTimeoutMs: 300,
    });
    [lateRecovers, lateStale] = await Promise.all([
      runVoiceConcurrency({ ...late, url: url.replace('/api/telephony/stream', '/late-recovers') }),
      runVoiceConcurrency({ ...late, url: url.replace('/api/telephony/stream', '/late-stale') }),
    ]);
    [confirmedPair, isolated] = await Promise.all([
      runVoiceConcurrency({ ...shaped, url: url.replace('/api/telephony/stream', '/pair') }),
      runVoiceConcurrency({ ...shaped, url: url.replace('/api/telephony/stream', '/isolated') }),
    ]);
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
    ['confirmed pair: breach/pass/breach/breach rows at N=3/5/7/9', confirmedPair.levels.map((l) => `${l.concurrency}:${l.breached}`).join(' ') === '3:true 5:false 7:true 9:true'],
    ['confirmed pair: stopped on the pair, firstBreachAt = 7 (not 3)', confirmedPair.stoppedBecause === 'two_consecutive_breaches' && confirmedPair.firstBreachAt === 7],
    ['confirmed pair: replicaTrigger = 5 (highest pass before the pair)', confirmedPair.replicaTrigger === 5],
    ['confirmed pair: stopReason names the ignored isolated breach at N=3', confirmedPair.stopReason.includes('N=7, N=9') && confirmedPair.stopReason.includes('Isolated breach at N=3')],
    ['isolated: ran to max, row at N=5 breached only', isolated.stoppedBecause === 'max_reached' && isolated.levels.map((l) => `${l.concurrency}:${l.breached}`).join(' ') === '3:false 5:true 7:false 9:false'],
    ['isolated: firstBreachAt null, replicaTrigger = top passing level (9)', isolated.firstBreachAt === null && isolated.replicaTrigger === 9],
    ['isolated: stopReason says the isolated breach is not the trigger', isolated.stopReason.includes('Isolated breach at N=5') && isolated.stopReason.includes('not the trigger')],
    ['late reply: turn 1 noReply, turn 2 sampled by its own post-transcript frame (1 sample, 1 noReply)', lateRecovers.levels[0]?.turnsAttempted === 2 && lateRecovers.levels[0]?.samples === 1 && lateRecovers.levels[0]?.noReply === 1],
    ['late reply: the only sample is turn 2\'s own ~100 ms TTFA, never 0', (lateRecovers.levels[0]?.ttfaMs?.p95 ?? 0) >= 30 && (lateRecovers.levels[0]?.ttfaMs?.p95 ?? 0) <= 500 && (lateRecovers.levels[0]?.ttfaMs?.max ?? 0) > 0],
    ['late reply, stale frame only: both turns noReply, no 0 ms sample, level breached', lateStale.levels[0]?.turnsAttempted === 2 && lateStale.levels[0]?.samples === 0 && lateStale.levels[0]?.noReply === 2 && lateStale.levels[0]?.ttfaMs === null && lateStale.levels[0]?.breached === true],
    ['finished in < 30 s', elapsedMs < 30_000],
  ];

  const failed = checks.filter(([, ok]) => !ok);
  process.stdout.write(
    `\nvoice realtime concurrency self-check against ${url}\n` +
      checks.map(([name, ok]) => `  ${ok ? '✓' : '✗'} ${name}`).join('\n') +
      `\n\n  passing:   ${summaryLine(passing)}\n` +
      `  breaching: ${summaryLine(breaching)}\n` +
      `  silent:    ${summaryLine(silent)}\n` +
      `  pair:      ${summaryLine(confirmedPair)}\n` +
      `  isolated:  ${summaryLine(isolated)}\n` +
      `  late-recovers: ${formatLevel(lateRecovers.levels[0])}\n` +
      `  late-stale:    ${formatLevel(lateStale.levels[0])}\n` +
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
