/**
 * Production / staging smoke test (P7-023).
 *
 * Usage:
 *   npm run smoke-test                    # hits http://localhost:3000
 *   npm run smoke-test -- --env=staging   # uses STAGING_API_URL
 *   npm run smoke-test -- --env=prod      # uses PRODUCTION_API_URL
 *   npm run smoke-test -- --base=https://example.com
 *
 * Hits the unauthenticated liveness endpoints that should always be
 * green when a deploy is healthy. Exits 0 on success, 1 on the first
 * failure with the failing endpoint named. Document this command in
 * the rollback runbook so on-call can verify a redeploy in under 30s.
 */

interface Probe {
  name: string;
  path: string;
  expectStatus: number | number[];
  // If set, the body must contain this string. Cheap defense-in-depth
  // against a 200 from the load balancer when the app itself is down.
  expectBodyContains?: string;
}

const PROBES: Probe[] = [
  { name: 'liveness', path: '/health', expectStatus: 200, expectBodyContains: '"status"' },
  // /ready returns 503 when a critical dependency is down — that is
  // exactly the signal a smoke check must fail on, not paper over.
  { name: 'readiness', path: '/ready', expectStatus: 200 },
  // /api/telephony/health always returns 200 even when capabilities are
  // degraded; the structured payload sets `ok: false` with `warnings`
  // in that case (see TelephonyHealthReport in routes/telephony.ts).
  // Require `"ok":true` in the body so a degraded subsystem fails the
  // probe instead of silently passing.
  { name: 'telephony-health', path: '/api/telephony/health', expectStatus: 200, expectBodyContains: '"ok":true' },
];

function parseArgs(argv: string[]): { base: string } {
  const args = new Map<string, string>();
  for (const arg of argv.slice(2)) {
    const m = arg.match(/^--([^=]+)=(.+)$/);
    if (m) args.set(m[1], m[2]);
  }
  const env = args.get('env');
  const base = args.get('base');
  if (base) return { base: base.replace(/\/$/, '') };
  if (env === 'staging') {
    const url = process.env.STAGING_API_URL;
    if (!url) throw new Error('STAGING_API_URL not set');
    return { base: url.replace(/\/$/, '') };
  }
  if (env === 'prod' || env === 'production') {
    const url = process.env.PRODUCTION_API_URL;
    if (!url) throw new Error('PRODUCTION_API_URL not set');
    return { base: url.replace(/\/$/, '') };
  }
  // Reject typos like --env=stagin so a rollback verification doesn't
  // silently probe localhost while the operator thinks they hit prod.
  if (env !== undefined) {
    throw new Error(
      `Unknown --env value "${env}". Expected one of: staging, prod, production. ` +
        'Use --base=<url> for arbitrary targets.'
    );
  }
  return { base: 'http://localhost:3000' };
}

async function main(): Promise<void> {
  const { base } = parseArgs(process.argv);
  console.log(`Smoke test → ${base}`);

  let failed = 0;
  for (const probe of PROBES) {
    const url = `${base}${probe.path}`;
    const t0 = Date.now();
    try {
      const res = await fetch(url, { method: 'GET' });
      const body = await res.text();
      const expected = Array.isArray(probe.expectStatus) ? probe.expectStatus : [probe.expectStatus];
      const statusOk = expected.includes(res.status);
      const bodyOk = !probe.expectBodyContains || body.includes(probe.expectBodyContains);
      const ms = Date.now() - t0;
      if (statusOk && bodyOk) {
        console.log(`  ok  ${probe.name.padEnd(20)} ${res.status} ${ms}ms ${probe.path}`);
      } else {
        failed += 1;
        console.error(
          `  FAIL ${probe.name.padEnd(20)} ${res.status} ${ms}ms ${probe.path}` +
            (statusOk ? '' : ` — status ${res.status} not in [${expected.join(',')}]`) +
            (bodyOk ? '' : ` — body missing "${probe.expectBodyContains}"`),
        );
        console.error(`       body: ${body.slice(0, 200)}`);
      }
    } catch (err) {
      failed += 1;
      const ms = Date.now() - t0;
      console.error(`  FAIL ${probe.name.padEnd(20)} ERR  ${ms}ms ${probe.path} — ${(err as Error).message}`);
    }
  }

  if (failed > 0) {
    console.error(`\nSmoke test FAILED (${failed}/${PROBES.length} probes failed).`);
    process.exit(1);
  }
  console.log(`\nSmoke test passed (${PROBES.length}/${PROBES.length}).`);
}

main().catch((err) => {
  console.error('Smoke test crashed:', err);
  process.exit(1);
});
