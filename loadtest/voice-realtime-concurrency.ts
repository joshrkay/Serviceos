/**
 * Voice realtime concurrency sweep (U1 — voice-parity plan,
 * docs/plans/2026-10-16-001-feat-voice-parity-bland-avoca-plan.md).
 *
 * Drives N emulated Twilio Media Streams against ONE API process and records
 * the N at which p95 time-to-first-audio (TTFA) crosses a threshold (default
 * 800 ms). The highest passing N before that confirmed crossing is the
 * "replica trigger" docs/decisions.md D-043 records.
 *
 * Each emulated call is a `TwilioStreamEmulator`
 * (packages/api/src/ai/voice-quality/audio/twilio-stream-emulator.ts) — the
 * same client the Layer 2 harness uses, speaking the real Media Streams
 * protocol (connected/start → paced 20 ms μ-law `media` frames → `mark`
 * `eot-<n>` → collect the agent's reply frames → `stop`). TTFA is measured
 * exactly as Layer 2 measures it (audio-timings.ts): start = the moment the
 * caller's audio is fully delivered (the emulator's synthetic
 * `transcript_received`), stop = the first inbound `media` frame. A turn that
 * gets no reply frame within `--reply-timeout` is counted as `noReply`, not as
 * a 0 ms sample. Replied means the emulator found a first frame at/after the
 * turn's transcript timestamp (`ttfaMs > 0`); a previous turn's late reply that
 * lands during the next caller fixture is stale, so that next turn is `noReply`
 * unless it gets its own post-transcript frame.
 *
 * Sweep: for N = start, start+step, … ≤ max: open N streams (unique CallSids),
 * each sends `--turns` utterances with `--pause` ms between them, bounded by a
 * `--hold` wall-clock cap per level (a stream starts no new turn after the
 * cap). Collect every TTFA sample for the level → p50/p95/p99 (measured over
 * real replies, informational), errors, dropped streams.
 *
 * Breach rule — the DECISION number is `p95CensoredMs`, NOT `ttfaMs.p95`.
 * Surviving samples alone would let 99 timed-out turns plus one fast reply pass,
 * so the decision runs on a CENSORED sample set: every turn that produced no
 * post-transcript reply (`noReply`), every turn that threw, and every turn a
 * dropped stream never got to run (`o.turns - turnsAttempted`; all `o.turns` for
 * a stream that failed to open) contributes one censored value = the reply
 * timeout (floored at threshold + 1 so a timeout at or below the threshold can
 * never pass). `p95CensoredMs` = p95 of `samples ∪ censored`; a level breaches
 * when it exceeds the threshold, which happens as soon as the censored share
 * exceeds 5 %. A level with no real sample at all is always a breach. Stop early
 * once a level breaches on two consecutive levels.
 *
 * Capacity result — derived from the CONFIRMED breach pair only, never from the
 * first breach seen: when the sweep stops on two consecutive breaching levels,
 * `firstBreachAt` is the first level of that final pair and `replicaTrigger` is
 * the highest passing level below it (null if none). When the sweep reaches
 * `max` with no such pair, `firstBreachAt` is null and `replicaTrigger` is the
 * highest passing level overall; an isolated breach (breach/pass/…) stays in
 * the per-level rows but is not a trigger, and `stopReason` says so.
 *
 * Caller audio: `--fixture` (16 kHz or 8 kHz mono PCM16, raw or WAV) — needed
 * when the target runs a real STT, which transcribes nothing from a tone.
 * Without it a 1.5 s 440 Hz tone stands in and the report says so.
 *
 * Auth: the emulator sends no `x-twilio-signature`, so the target must be a
 * boot whose `attachMediaStreamServer` deps set `authTestMode: true` and whose
 * `VoiceSessionStore` already holds a session for each CallSid this driver
 * uses (`<prefix><N>_<i>`, see `--callsid-prefix`). See loadtest/README.md
 * "Voice realtime concurrency" for why there is no env var for either.
 *
 * Dependency-free apart from `ws` (via the emulator), like the other drivers
 * here. Never throws on a single stream failure — it is counted. Exit 0 when a
 * trigger was found or max was reached cleanly; 1 on a harness error (bad
 * fixture, or the first level could not open a single stream).
 *
 * Usage:
 *   tsx loadtest/voice-realtime-concurrency.ts \
 *     --url ws://localhost:3000/api/telephony/stream \
 *     --start 1 --step 2 --max 40 --turns 3 --hold 20 --threshold 800 \
 *     --fixture loadtest/fixtures/caller-16k.wav \
 *     --out voice-realtime-concurrency-report.json
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

import { TwilioStreamEmulator } from '../packages/api/src/ai/voice-quality/audio/twilio-stream-emulator';
import { AgentEventBus } from '../packages/api/src/ai/voice-quality/event-bus';
import { downsample16to8 } from '../packages/api/src/ai/voice-quality/audio/pcm-codec';
import { percentile } from './http-load';

// ─── Options ─────────────────────────────────────────────────────────────────

export interface VoiceConcurrencyOptions {
  /** Media Streams WS endpoint. */
  url: string;
  /** First concurrency level. */
  start: number;
  /** Increment between levels. */
  step: number;
  /** Last concurrency level. */
  max: number;
  /** Caller utterances per stream per level. */
  turns: number;
  /** Wall-clock cap per level (seconds); no new turn starts after it. */
  holdSeconds: number;
  /** p95 TTFA threshold (ms). */
  thresholdMs: number;
  /** Pause between a stream's turns (ms). */
  pauseMs: number;
  /** Bound on waiting for a turn's first reply frame (ms). */
  replyTimeoutMs: number;
  /** Inbound silence that ends the agent's reply (ms). */
  silenceWindowMs: number;
  /** Stagger between stream openings within a level (ms). */
  staggerMs: number;
  /** CallSid prefix; CallSid = `<prefix><N>_<i>`. */
  callSidPrefix: string;
  /** Path to the caller utterance (PCM16 mono 16 kHz or 8 kHz, raw or WAV). */
  fixture?: string;
  /** JSON report path. */
  out?: string;
}

export const DEFAULT_OPTIONS: VoiceConcurrencyOptions = {
  url: 'ws://localhost:3000/api/telephony/stream',
  start: 1,
  step: 2,
  max: 40,
  turns: 3,
  holdSeconds: 20,
  thresholdMs: 800,
  pauseMs: 500,
  replyTimeoutMs: 10_000,
  silenceWindowMs: 500,
  staggerMs: 20,
  callSidPrefix: 'CA_LOADTEST_',
  out: 'voice-realtime-concurrency-report.json',
};

// ─── Report ──────────────────────────────────────────────────────────────────

export interface LevelRow {
  /** Concurrent streams at this level. */
  concurrency: number;
  /** Streams that completed the Media Streams handshake. */
  streamsOpened: number;
  /** Streams that failed to open or died mid-level. */
  streamsDropped: number;
  /** Turns attempted (caller audio fully sent). */
  turnsAttempted: number;
  /** Turns with a measured TTFA. */
  samples: number;
  /** Turns whose first reply frame never arrived within `replyTimeoutMs`. */
  noReply: number;
  /** Turns that threw (socket closed mid-turn, etc.). */
  errors: number;
  /**
   * Turns with no measured TTFA that the breach decision counts as the censored
   * value: `noReply` + `errors` + turns dropped/failed-to-open streams never ran.
   */
  censored: number;
  /** TTFA percentiles (ms) over REAL replies only — informational, does not drive `breached`. */
  ttfaMs: { p50: number; p95: number; p99: number; max: number; mean: number } | null;
  /**
   * p95 of real samples ∪ censored values (each censored turn = max(reply
   * timeout, threshold + 1)); null when the level has neither. THIS drives `breached`.
   */
  p95CensoredMs: number | null;
  /** `p95CensoredMs` > threshold, or no real sample at all. */
  breached: boolean;
  /** Wall-clock the level took (ms). */
  durationMs: number;
}

export interface VoiceConcurrencyReport {
  url: string;
  startedAt: string;
  finishedAt: string;
  config: Omit<VoiceConcurrencyOptions, 'out' | 'fixture'>;
  fixture: {
    /** 'synthetic-tone-440hz' when no `--fixture` was given. */
    source: string;
    durationMs: number;
    /** Set when the stand-in tone was used — real STT will not transcribe it. */
    note?: string;
  };
  levels: LevelRow[];
  /**
   * First level of the confirmed breach pair (the two consecutive breaching
   * levels that stopped the sweep); null when the sweep ended at `max` without
   * one — an isolated breach does not count.
   */
  firstBreachAt: number | null;
  /**
   * The replica trigger: with a confirmed pair, the highest passing level below
   * `firstBreachAt` (null when none passed); without one, the highest passing
   * level overall (a lower bound — capacity is at least this).
   */
  replicaTrigger: number | null;
  /** Why the sweep ended. */
  stoppedBecause: 'two_consecutive_breaches' | 'max_reached';
  /** Human-readable stop reason, including any isolated breaches ignored. */
  stopReason: string;
}

// ─── Caller audio ────────────────────────────────────────────────────────────

const PCM8K_BYTES_PER_MS = 16; // 8000 samples/s × 2 bytes / 1000

/** 1.5 s 440 Hz sine, PCM16 LE mono 8 kHz at ~−12 dBFS — the stand-in utterance. */
export function synthesizeTone8k(durationMs = 1500, hz = 440): Buffer {
  const samples = Math.floor((8000 * durationMs) / 1000);
  const out = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    out.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / 8000) * 8000), i * 2);
  }
  return out;
}

/**
 * Parse a RIFF/WAVE file: returns the PCM16 data plus its format. Only the
 * `fmt ` and `data` chunks are read; other chunks are skipped.
 */
function parseWav(file: Buffer): { pcm: Buffer; sampleRate: number; channels: number; bits: number } {
  let offset = 12;
  let fmt: { sampleRate: number; channels: number; bits: number; format: number } | null = null;
  let data: Buffer | null = null;
  while (offset + 8 <= file.length) {
    const id = file.toString('ascii', offset, offset + 4);
    const size = file.readUInt32LE(offset + 4);
    const body = file.subarray(offset + 8, Math.min(file.length, offset + 8 + size));
    if (id === 'fmt ') {
      fmt = {
        format: body.readUInt16LE(0),
        channels: body.readUInt16LE(2),
        sampleRate: body.readUInt32LE(4),
        bits: body.readUInt16LE(14),
      };
    } else if (id === 'data') {
      data = body;
    }
    offset += 8 + size + (size % 2); // chunks are word-aligned
  }
  if (!fmt || !data) throw new Error('WAV fixture: missing fmt/data chunk');
  if (fmt.format !== 1 || fmt.bits !== 16) {
    throw new Error(`WAV fixture: need PCM16 (format 1, 16-bit), got format ${fmt.format} / ${fmt.bits}-bit`);
  }
  return { pcm: data, sampleRate: fmt.sampleRate, channels: fmt.channels, bits: fmt.bits };
}

/**
 * Load the caller utterance as PCM16 LE mono 8 kHz — the format the emulator
 * frames for Twilio. A WAV carries its own rate; a raw file is taken as
 * 16 kHz mono PCM16 (`--fixture` contract). 16 kHz is downsampled with the
 * production codec's `downsample16to8`; 8 kHz passes through.
 */
export function loadCallerAudio(fixturePath?: string): { audio: Buffer; fixture: VoiceConcurrencyReport['fixture'] } {
  if (!fixturePath) {
    const audio = synthesizeTone8k();
    return {
      audio,
      fixture: {
        source: 'synthetic-tone-440hz',
        durationMs: audio.length / PCM8K_BYTES_PER_MS,
        note: 'no --fixture given; a 1.5 s 440 Hz tone stood in for the caller. A real STT transcribes nothing from it — pass --fixture for a run against a live stack.',
      },
    };
  }
  const file = readFileSync(fixturePath);
  let pcm: Buffer;
  let sampleRate: number;
  if (file.length >= 12 && file.toString('ascii', 0, 4) === 'RIFF' && file.toString('ascii', 8, 12) === 'WAVE') {
    const wav = parseWav(file);
    if (wav.channels !== 1) throw new Error(`fixture ${fixturePath}: need mono, got ${wav.channels} channels`);
    pcm = wav.pcm;
    sampleRate = wav.sampleRate;
  } else {
    pcm = file;
    sampleRate = 16_000;
  }
  if (sampleRate === 16_000) pcm = downsample16to8(pcm);
  else if (sampleRate !== 8000) throw new Error(`fixture ${fixturePath}: need 16 kHz or 8 kHz, got ${sampleRate} Hz`);
  if (pcm.length < PCM8K_BYTES_PER_MS * 100) throw new Error(`fixture ${fixturePath}: shorter than 100 ms`);
  return { audio: pcm, fixture: { source: fixturePath, durationMs: pcm.length / PCM8K_BYTES_PER_MS } };
}

// ─── One level ───────────────────────────────────────────────────────────────

interface StreamOutcome {
  opened: boolean;
  dropped: boolean;
  turnsAttempted: number;
  ttfaMs: number[];
  noReply: number;
  errors: number;
  /** Turns this stream was expected to run but a drop / failed open prevented. */
  skippedByDrop: number;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => {
    setTimeout(r, ms);
  });

async function runStream(
  o: VoiceConcurrencyOptions,
  callSid: string,
  audio: Buffer,
  deadline: number,
): Promise<StreamOutcome> {
  const out: StreamOutcome = { opened: false, dropped: false, turnsAttempted: 0, ttfaMs: [], noReply: 0, errors: 0, skippedByDrop: 0 };
  // One bus per stream: the emulator records its synthetic transcript_received
  // there; nothing reads it back, so the log stays tiny.
  const emulator = new TwilioStreamEmulator({
    serverUrl: o.url,
    bus: new AgentEventBus(),
    silenceWindowMs: o.silenceWindowMs,
    firstAudioTimeoutMs: o.replyTimeoutMs,
  });
  try {
    await emulator.start(callSid);
    out.opened = true;
  } catch {
    out.dropped = true;
    out.skippedByDrop = o.turns;
    await emulator.hangup().catch(() => {});
    return out;
  }
  try {
    for (let turn = 0; turn < o.turns; turn++) {
      if (performance.now() >= deadline) break;
      if (turn > 0) await sleep(o.pauseMs);
      out.turnsAttempted++;
      try {
        const result = await emulator.sendCallerUtterance(audio);
        // Replied only when the emulator found a first frame AT/AFTER this
        // turn's transcript timestamp: its `ttfaMs` is `firstReply.ts -
        // transcriptReceivedTs`, and 0 exactly when no such frame exists.
        // `numFrames` is NOT evidence of a reply — it also counts stale frames
        // retained from a previous turn's timed-out reply that landed while this
        // turn's caller fixture was still streaming (the emulator resets its
        // buffer at the start of each `sendCallerUtterance`, but a late frame
        // arrives after that reset). Counting those would add a 0 ms sample.
        if (Number.isFinite(result.ttfaMs) && result.ttfaMs > 0) out.ttfaMs.push(result.ttfaMs);
        else out.noReply++;
      } catch {
        // Socket closed mid-turn (server shed the call, etc.): the stream is
        // gone, so count it dropped and stop driving it.
        out.errors++;
        out.dropped = true;
        out.skippedByDrop = Math.max(0, o.turns - out.turnsAttempted);
        break;
      }
    }
  } finally {
    await emulator.hangup().catch(() => {});
  }
  return out;
}

export async function runLevel(
  o: VoiceConcurrencyOptions,
  concurrency: number,
  audio: Buffer,
): Promise<LevelRow> {
  const t0 = performance.now();
  const deadline = t0 + o.holdSeconds * 1000;
  const streams = await Promise.all(
    Array.from({ length: concurrency }, async (_, i) => {
      await sleep(i * o.staggerMs);
      return runStream(o, `${o.callSidPrefix}${concurrency}_${i}`, audio, deadline);
    }),
  );
  const ttfa = streams.flatMap((s) => s.ttfaMs).sort((a, b) => a - b);
  const stats =
    ttfa.length === 0
      ? null
      : {
          p50: Math.round(percentile(ttfa, 50)),
          p95: Math.round(percentile(ttfa, 95)),
          p99: Math.round(percentile(ttfa, 99)),
          max: Math.round(ttfa[ttfa.length - 1]),
          mean: Math.round(ttfa.reduce((a, b) => a + b, 0) / ttfa.length),
        };
  // Censored set: no-reply, errored and dropped-stream turns all count at the
  // reply timeout (floored above the threshold) so they cannot be hidden by the
  // surviving fast samples.
  const noReply = streams.reduce((a, s) => a + s.noReply, 0);
  const errors = streams.reduce((a, s) => a + s.errors, 0);
  const censored = streams.reduce((a, s) => a + s.noReply + s.errors + s.skippedByDrop, 0);
  const censoredValueMs = Math.max(o.replyTimeoutMs, o.thresholdMs + 1);
  const withCensored = [...ttfa, ...Array.from({ length: censored }, () => censoredValueMs)].sort((a, b) => a - b);
  const p95CensoredMs = withCensored.length === 0 ? null : Math.round(percentile(withCensored, 95));
  return {
    concurrency,
    streamsOpened: streams.filter((s) => s.opened).length,
    streamsDropped: streams.filter((s) => s.dropped).length,
    turnsAttempted: streams.reduce((a, s) => a + s.turnsAttempted, 0),
    samples: ttfa.length,
    noReply,
    errors,
    censored,
    ttfaMs: stats,
    p95CensoredMs,
    breached: stats === null || p95CensoredMs === null || p95CensoredMs > o.thresholdMs,
    durationMs: Math.round(performance.now() - t0),
  };
}

// ─── Sweep ───────────────────────────────────────────────────────────────────

export function formatLevel(row: LevelRow): string {
  const t = row.ttfaMs;
  const pct = t ? `p50 ${t.p50}  p95 ${t.p95}  p99 ${t.p99} ms` : 'p50 —  p95 —  p99 — (no sample)';
  const decisive = `  p95cens ${row.p95CensoredMs ?? '—'}  censored ${row.censored}`;
  return (
    `N=${String(row.concurrency).padStart(3)}  ${pct}  samples ${row.samples}/${row.turnsAttempted}` +
    `${decisive}  noReply ${row.noReply}  errors ${row.errors}  dropped ${row.streamsDropped}/${row.concurrency}` +
    `  ${(row.durationMs / 1000).toFixed(1)}s  ${row.breached ? 'BREACH' : 'ok'}`
  );
}

export async function runVoiceConcurrency(o: VoiceConcurrencyOptions): Promise<VoiceConcurrencyReport> {
  if (!(o.start >= 1) || !(o.step >= 1) || !(o.max >= o.start) || !(o.turns >= 1)) {
    throw new Error('need --start ≥ 1, --step ≥ 1, --max ≥ --start, --turns ≥ 1');
  }
  const { audio, fixture } = loadCallerAudio(o.fixture);
  const startedAt = new Date().toISOString();
  const { out: _out, fixture: _fixture, ...config } = o;

  process.stdout.write(
    `voice realtime concurrency: ${o.url}\n` +
      `  N = ${o.start} → ${o.max} step ${o.step} · ${o.turns} turns/stream · hold cap ${o.holdSeconds}s · threshold censored-p95 TTFA ≤ ${o.thresholdMs} ms (timed-out/errored/dropped turns count at the reply timeout)\n` +
      `  caller audio: ${fixture.source} (${fixture.durationMs} ms)${fixture.note ? ' — STAND-IN' : ''}\n`,
  );

  const levels: LevelRow[] = [];
  let consecutiveBreaches = 0;
  let stoppedBecause: VoiceConcurrencyReport['stoppedBecause'] = 'max_reached';
  for (let n = o.start; n <= o.max; n += o.step) {
    const row = await runLevel(o, n, audio);
    levels.push(row);
    process.stdout.write(`  ${formatLevel(row)}\n`);
    if (levels.length === 1 && row.streamsOpened === 0) {
      throw new Error(`no stream could open at N=${n} against ${o.url} — is the target up and accepting unsigned upgrades?`);
    }
    consecutiveBreaches = row.breached ? consecutiveBreaches + 1 : 0;
    if (consecutiveBreaches >= 2) {
      stoppedBecause = 'two_consecutive_breaches';
      break;
    }
  }

  // Derive the capacity result from the confirmed breach pair (the last two
  // levels when the sweep stopped on two consecutive breaches), not the first
  // breach seen: an earlier isolated breach that later recovered is not a trigger.
  const confirmed = stoppedBecause === 'two_consecutive_breaches';
  const firstBreachAt = confirmed ? levels[levels.length - 2].concurrency : null;
  const passing = levels.filter((l) => !l.breached && (firstBreachAt === null || l.concurrency < firstBreachAt));
  const replicaTrigger = passing.length ? passing[passing.length - 1].concurrency : null;
  const isolated = levels
    .filter((l) => l.breached && (firstBreachAt === null || l.concurrency < firstBreachAt))
    .map((l) => l.concurrency);
  const isolatedNote = isolated.length
    ? ` Isolated breach${isolated.length > 1 ? 'es' : ''} at N=${isolated.join(', ')} recovered and ${isolated.length > 1 ? 'are' : 'is'} not the trigger.`
    : '';
  const stopReason = confirmed
    ? `censored p95 breached on two consecutive levels (N=${firstBreachAt}, N=${levels[levels.length - 1].concurrency}).${isolatedNote}`
    : `reached max N=${levels[levels.length - 1].concurrency} without two consecutive breaching levels.${isolatedNote}`;

  const report: VoiceConcurrencyReport = {
    url: o.url,
    startedAt,
    finishedAt: new Date().toISOString(),
    config,
    fixture,
    levels,
    firstBreachAt,
    replicaTrigger,
    stoppedBecause,
    stopReason,
  };
  if (o.out) writeFileSync(o.out, JSON.stringify(report, null, 2));
  return report;
}

export function summaryLine(r: VoiceConcurrencyReport): string {
  const top = r.levels[r.levels.length - 1].concurrency;
  const isolated = r.stopReason.includes('Isolated') ? ' (isolated breach(es) recovered; not the trigger)' : '';
  // The decisive level: the first level of the confirmed breach pair, else the top level swept.
  const at = r.levels.find((l) => l.concurrency === (r.firstBreachAt ?? top)) ?? r.levels[r.levels.length - 1];
  const evidence = ` [N=${at.concurrency}: censored p95 ${at.p95CensoredMs ?? '—'} ms, ${at.censored} censored turn(s)]`;
  if (r.firstBreachAt === null) {
    return r.replicaTrigger === null
      ? `no confirmed breach (two consecutive levels) up to N=${top} (max reached) but no level passed either; replica trigger = none${isolated}${evidence}`
      : `no confirmed breach (two consecutive levels) up to N=${top} (max reached); replica trigger = ${r.replicaTrigger} (≥ this)${isolated}${evidence}`;
  }
  const trigger = r.replicaTrigger === null ? 'none (no level passed before the confirmed breach)' : String(r.replicaTrigger);
  return `censored p95 TTFA (timeouts/errors/drops counted at the reply timeout) crossed ${r.config.thresholdMs} ms on two consecutive levels starting at N=${r.firstBreachAt}; replica trigger = ${trigger}${isolated}${evidence}`;
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

export function parseVoiceArgs(argv: string[]): VoiceConcurrencyOptions {
  const get = (flag: string, def?: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : def;
  };
  const num = (flag: string, def: number): number => {
    const v = get(flag);
    if (v === undefined) return def;
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`${flag}: expected a number, got "${v}"`);
    return n;
  };
  const d = DEFAULT_OPTIONS;
  return {
    url: get('--url', d.url)!,
    start: num('--start', d.start),
    step: num('--step', d.step),
    max: num('--max', d.max),
    turns: num('--turns', d.turns),
    holdSeconds: num('--hold', d.holdSeconds),
    thresholdMs: num('--threshold', d.thresholdMs),
    pauseMs: num('--pause', d.pauseMs),
    replyTimeoutMs: num('--reply-timeout', d.replyTimeoutMs),
    silenceWindowMs: num('--silence', d.silenceWindowMs),
    staggerMs: num('--stagger', d.staggerMs),
    callSidPrefix: get('--callsid-prefix', d.callSidPrefix)!,
    fixture: get('--fixture'),
    out: get('--out', d.out),
  };
}

// Only run when invoked directly (not when imported by the self-check).
const invokedDirectly =
  typeof process !== 'undefined' && process.argv[1] && /voice-realtime-concurrency\.ts$/.test(process.argv[1]);
if (invokedDirectly) {
  let opts: VoiceConcurrencyOptions;
  try {
    opts = parseVoiceArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
  runVoiceConcurrency(opts)
    .then((report) => {
      process.stdout.write(`${summaryLine(report)}\n`);
      if (opts.out) process.stdout.write(`report written to ${opts.out}\n`);
      // Mark-ack timers on hung-up emulators are cleared; exit explicitly all the same.
      process.exit(0);
    })
    .catch((err) => {
      process.stderr.write(`voice realtime concurrency run failed: ${err?.message ?? err}\n`);
      process.exit(1);
    });
}
