/**
 * HTTP load-harness self-check (U1 — scale-to-1000 plan).
 *
 * Mirrors the established `voice-load:selfcheck` precedent
 * (docs/runbooks/voice-capacity.md): spins up a local mock HTTP server, runs the
 * load driver against it with small parameters, and asserts the harness +
 * report pipeline are operational. This proves the TOOLING works without
 * booting the full API or measuring production capacity — the real baseline is
 * captured against the docker-compose topology or staging (see loadtest/README.md).
 *
 * Exit 0 on a healthy run, non-zero on any harness defect.
 *
 * Run: tsx loadtest/http-load-selfcheck.ts
 */

import http from 'node:http';
import { runLoad, DEFAULT_ENDPOINTS, type LoadReport } from './http-load';

async function main(): Promise<void> {
  // Mock API: 200 for every known path after a tiny artificial latency so the
  // driver records non-zero, varied durations and computes real percentiles.
  const server = http.createServer((req, res) => {
    const delay = 2 + (req.url ? req.url.length % 7 : 0); // 2–8ms, varied
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, path: req.url }));
    }, delay);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('failed to bind mock server');
  const url = `http://127.0.0.1:${addr.port}`;

  let report: LoadReport;
  try {
    report = await runLoad({
      url,
      max: 25,
      rampSeconds: 1,
      holdSeconds: 2,
      rampdownSeconds: 1,
      endpoints: DEFAULT_ENDPOINTS,
      allowStatuses: [],
      timeoutMs: 2000,
      assert: false,
    });
  } finally {
    server.close();
  }

  const checks: Array<[string, boolean]> = [
    ['made requests', report.totalRequests > 0],
    ['computed throughput', report.throughputRps > 0],
    ['computed p95', report.latencyMs.p95 >= 0],
    ['p99 >= p50', report.latencyMs.p99 >= report.latencyMs.p50],
    ['zero errors against mock', report.errors === 0],
    ['per-endpoint breakdown present', Object.keys(report.perEndpoint).length > 0],
    ['thresholds evaluated', report.thresholds.passed === true],
  ];

  const failed = checks.filter(([, ok]) => !ok);
  process.stdout.write(
    `\nHTTP load self-check against ${url}\n` +
      checks.map(([name, ok]) => `  ${ok ? '✓' : '✗'} ${name}`).join('\n') +
      `\n\n  ${report.totalRequests} requests, ${report.throughputRps} req/s, ` +
      `p95 ${report.latencyMs.p95}ms, errors ${report.errors}\n`,
  );

  if (failed.length > 0) {
    process.stderr.write(`\nself-check FAILED: ${failed.map(([n]) => n).join(', ')}\n`);
    process.exit(1);
  }
  process.stdout.write('\nself-check PASSED — harness + report pipeline operational.\n');
}

main().catch((err) => {
  process.stderr.write(`self-check crashed: ${err?.stack ?? err}\n`);
  process.exit(1);
});
