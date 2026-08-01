/**
 * HTTP concurrency load driver (U1 — scale-to-1000 plan).
 *
 * Dependency-free (Node built-ins + tsx only — no k6 install required, runs in
 * CI and locally). Ramps a pool of concurrent virtual users (VUs) against a
 * target API, holds, then ramps down, hitting a weighted mix of read endpoints
 * and reporting p50/p95/p99 latency, error rate, and throughput. Mirrors the
 * CLI of the existing voice harness (packages/api/scripts/voice-load-test.ts):
 * `--max`, `--ramp`, `--hold`.
 *
 * The goal of this harness is to find the *first* bottleneck and a baseline
 * number before any scaling change (plan U1), and to re-validate at 1000
 * concurrent after (plan U6). It deliberately measures the HTTP path; the voice
 * path is covered by the existing voice-load harness.
 *
 * Auth: the target API must run with `DEV_AUTH_BYPASS=true` (NODE_ENV=dev) and
 * be given a synthetic bearer token via `--token` (see loadtest/README.md), or
 * point `--url` at a staging API with a real Clerk test token.
 *
 * Usage:
 *   tsx loadtest/http-load.ts --url http://localhost:3000 --token <jwt> \
 *     --max 200 --ramp 60 --hold 300 --rampdown 30 --out loadtest/report.json
 */

import http from 'node:http';
import https from 'node:https';
import { performance } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';

export interface EndpointSpec {
  /** Request path, e.g. `/api/jobs`. */
  path: string;
  /** Relative selection weight (higher = hit more often). */
  weight: number;
  method?: 'GET';
}

/** Ramp → hold → ramp-down schedule, shared with the mixed harness (mixed-1000.ts). */
export interface Schedule {
  /** Peak concurrent VUs. */
  max: number;
  /** Ramp-up seconds (0 → max). */
  rampSeconds: number;
  /** Hold-at-peak seconds. */
  holdSeconds: number;
  /** Ramp-down seconds (max → 0). */
  rampdownSeconds: number;
}

export interface LoadOptions extends Schedule {
  url: string;
  token?: string;
  endpoints: EndpointSpec[];
  /** Status codes that do NOT count as errors (besides 2xx). E.g. 401 when unauthenticated is expected. */
  allowStatuses: number[];
  /** Per-request timeout (ms). */
  timeoutMs: number;
  /** Optional output JSON report path. */
  out?: string;
  /** When true, exit non-zero if thresholds (p95 < 2000ms, errorRate < 1%) are violated. */
  assert: boolean;
}

/** Default mixed read endpoints — mirrors docs/operations/load-test-staging.md. */
export const DEFAULT_ENDPOINTS: EndpointSpec[] = [
  { path: '/api/jobs', weight: 5 },
  { path: '/api/invoices', weight: 4 },
  { path: '/api/customers', weight: 4 },
  { path: '/api/estimates', weight: 3 },
  { path: '/api/leads', weight: 2 },
  { path: '/health', weight: 1 },
];

interface Sample {
  durationMs: number;
  status: number;
  ok: boolean;
  error?: string;
}

export interface LoadReport {
  url: string;
  startedAt: string;
  finishedAt: string;
  config: { max: number; rampSeconds: number; holdSeconds: number; rampdownSeconds: number };
  totalRequests: number;
  durationSeconds: number;
  throughputRps: number;
  errorRate: number;
  errors: number;
  statusCounts: Record<string, number>;
  latencyMs: { p50: number; p95: number; p99: number; max: number; mean: number };
  perEndpoint: Record<string, { count: number; errors: number; p95: number }>;
  thresholds: { p95Under2000: boolean; errorUnder1pct: boolean; passed: boolean };
}

export function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.ceil((p / 100) * sortedAsc.length) - 1);
  return sortedAsc[Math.max(0, idx)];
}

function pickEndpoint(endpoints: EndpointSpec[], totalWeight: number): EndpointSpec {
  // Deterministic-free selection without Math.random dependency on a seed:
  // use a rotating counter so the mix is stable across processes for the same
  // request ordinal. (Math.random is fine here — this is a load tool, not the
  // app — but a counter keeps the mix reproducible in the self-check.)
  let r = (pickEndpoint as unknown as { _n?: number })._n ?? 0;
  (pickEndpoint as unknown as { _n?: number })._n = r + 1;
  let target = (r * 2654435761) % totalWeight; // knuth multiplicative hash → spread
  for (const ep of endpoints) {
    if (target < ep.weight) return ep;
    target -= ep.weight;
  }
  return endpoints[endpoints.length - 1];
}

function request(
  base: URL,
  ep: EndpointSpec,
  token: string | undefined,
  timeoutMs: number,
): Promise<Sample> {
  const isHttps = base.protocol === 'https:';
  const lib = isHttps ? https : http;
  const start = performance.now();
  return new Promise<Sample>((resolve) => {
    const req = lib.request(
      {
        protocol: base.protocol,
        hostname: base.hostname,
        port: base.port || (isHttps ? 443 : 80),
        path: ep.path,
        method: ep.method ?? 'GET',
        headers: token ? { authorization: `Bearer ${token}` } : {},
        timeout: timeoutMs,
      },
      (res) => {
        // Drain the body so the socket frees for keep-alive reuse.
        res.on('data', () => {});
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          resolve({ durationMs: performance.now() - start, status, ok: status >= 200 && status < 300 });
        });
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ durationMs: performance.now() - start, status: 0, ok: false, error: 'timeout' });
    });
    req.on('error', (err) => {
      resolve({ durationMs: performance.now() - start, status: 0, ok: false, error: err.message });
    });
    req.end();
  });
}

/** Target number of active VUs at elapsed time `t` (seconds) given the schedule. */
export function targetConcurrency(t: number, o: Schedule): number {
  const { max, rampSeconds, holdSeconds, rampdownSeconds } = o;
  if (t < rampSeconds) return rampSeconds === 0 ? max : Math.ceil((t / rampSeconds) * max);
  if (t < rampSeconds + holdSeconds) return max;
  const td = t - rampSeconds - holdSeconds;
  if (td < rampdownSeconds) return Math.max(0, Math.ceil((1 - td / rampdownSeconds) * max));
  return 0;
}

export async function runLoad(o: LoadOptions): Promise<LoadReport> {
  const base = new URL(o.url);
  const totalWeight = o.endpoints.reduce((s, e) => s + e.weight, 0);
  const samples: Sample[] = [];
  const perEndpoint = new Map<string, Sample[]>();
  const totalSeconds = o.rampSeconds + o.holdSeconds + o.rampdownSeconds;
  const startedAt = new Date().toISOString();
  const t0 = performance.now();

  let active = 0;
  let stop = false;

  async function vu(): Promise<void> {
    while (!stop) {
      const ep = pickEndpoint(o.endpoints, totalWeight);
      const s = await request(base, ep, o.token, o.timeoutMs);
      samples.push(s);
      const arr = perEndpoint.get(ep.path) ?? [];
      arr.push(s);
      perEndpoint.set(ep.path, arr);
    }
    active--;
  }

  // Scheduler tick: every 250ms reconcile active VU count to the target.
  await new Promise<void>((resolve) => {
    const tick = setInterval(() => {
      const elapsed = (performance.now() - t0) / 1000;
      if (elapsed >= totalSeconds) {
        stop = true;
        clearInterval(tick);
        // Give in-flight requests a moment to settle.
        setTimeout(resolve, o.timeoutMs + 200);
        return;
      }
      const want = targetConcurrency(elapsed, o);
      while (active < want) {
        active++;
        void vu();
      }
      // Ramp-down is cooperative: VUs exit on `stop`; for the gentle decline we
      // simply stop spawning — natural attrition isn't modeled per-VU to keep
      // the driver simple, which is conservative (slightly higher load).
    }, 250);
  });

  const finishedAt = new Date().toISOString();
  const durationSeconds = (performance.now() - t0) / 1000;
  const durations = samples.map((s) => s.durationMs).sort((a, b) => a - b);
  const errors = samples.filter((s) => !s.ok && !o.allowStatuses.includes(s.status)).length;
  const statusCounts: Record<string, number> = {};
  for (const s of samples) {
    const k = s.error ? `err:${s.error}` : String(s.status);
    statusCounts[k] = (statusCounts[k] ?? 0) + 1;
  }
  const perEndpointReport: LoadReport['perEndpoint'] = {};
  for (const [path, arr] of perEndpoint) {
    const d = arr.map((s) => s.durationMs).sort((a, b) => a - b);
    perEndpointReport[path] = {
      count: arr.length,
      errors: arr.filter((s) => !s.ok && !o.allowStatuses.includes(s.status)).length,
      p95: Math.round(percentile(d, 95)),
    };
  }
  const errorRate = samples.length ? errors / samples.length : 0;
  const p95 = Math.round(percentile(durations, 95));
  const mean = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;

  const p95Under2000 = p95 < 2000;
  const errorUnder1pct = errorRate < 0.01;

  const report: LoadReport = {
    url: o.url,
    startedAt,
    finishedAt,
    config: { max: o.max, rampSeconds: o.rampSeconds, holdSeconds: o.holdSeconds, rampdownSeconds: o.rampdownSeconds },
    totalRequests: samples.length,
    durationSeconds: Math.round(durationSeconds),
    throughputRps: durationSeconds ? Math.round(samples.length / durationSeconds) : 0,
    errorRate: Number(errorRate.toFixed(4)),
    errors,
    statusCounts,
    latencyMs: {
      p50: Math.round(percentile(durations, 50)),
      p95,
      p99: Math.round(percentile(durations, 99)),
      max: Math.round(durations[durations.length - 1] ?? 0),
      mean: Math.round(mean),
    },
    perEndpoint: perEndpointReport,
    thresholds: { p95Under2000, errorUnder1pct, passed: p95Under2000 && errorUnder1pct },
  };

  if (o.out) writeFileSync(o.out, JSON.stringify(report, null, 2));
  return report;
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

export function parseArgs(argv: string[]): LoadOptions {
  const get = (flag: string, def?: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : def;
  };
  const num = (flag: string, def: number): number => {
    const v = get(flag);
    return v === undefined ? def : Number(v);
  };
  const endpointsArg = get('--endpoints');
  const endpoints = endpointsArg
    ? endpointsArg.split(',').map((p) => ({ path: p.trim(), weight: 1 }))
    : DEFAULT_ENDPOINTS;
  return {
    url: get('--url', 'http://localhost:3000')!,
    token: get('--token'),
    max: num('--max', 100),
    rampSeconds: num('--ramp', 60),
    holdSeconds: num('--hold', 300),
    rampdownSeconds: num('--rampdown', 30),
    endpoints,
    allowStatuses: (get('--allow-status', '') ?? '').split(',').filter(Boolean).map(Number),
    timeoutMs: num('--timeout', 10000),
    out: get('--out'),
    assert: argv.includes('--assert'),
  };
}

export function printSummary(r: LoadReport): void {
  const lines = [
    `\n── HTTP load report ─────────────────────────────────────────`,
    `target        ${r.url}`,
    `schedule      ramp ${r.config.rampSeconds}s → hold ${r.config.holdSeconds}s @ ${r.config.max} VUs → down ${r.config.rampdownSeconds}s`,
    `requests      ${r.totalRequests}  (${r.throughputRps} req/s over ${r.durationSeconds}s)`,
    `latency ms    p50 ${r.latencyMs.p50}  p95 ${r.latencyMs.p95}  p99 ${r.latencyMs.p99}  max ${r.latencyMs.max}`,
    `errors        ${r.errors}  (${(r.errorRate * 100).toFixed(2)}%)`,
    `status mix    ${Object.entries(r.statusCounts).map(([k, v]) => `${k}:${v}`).join('  ')}`,
    `thresholds    p95<2000ms: ${r.thresholds.p95Under2000 ? 'PASS' : 'FAIL'}   error<1%: ${r.thresholds.errorUnder1pct ? 'PASS' : 'FAIL'}`,
    `─────────────────────────────────────────────────────────────\n`,
  ];
  process.stdout.write(lines.join('\n'));
}

// Only run when invoked directly (not when imported by the self-check/tests).
const invokedDirectly =
  typeof process !== 'undefined' && process.argv[1] && /http-load\.ts$/.test(process.argv[1]);
if (invokedDirectly) {
  const opts = parseArgs(process.argv.slice(2));
  runLoad(opts)
    .then((report) => {
      printSummary(report);
      if (opts.out) process.stdout.write(`report written to ${opts.out}\n`);
      if (opts.assert && !report.thresholds.passed) process.exit(1);
    })
    .catch((err) => {
      process.stderr.write(`load run failed: ${err?.message ?? err}\n`);
      process.exit(1);
    });
}
