/**
 * Verify the deployed telephony / SMS *capability* config.
 *
 * Usage:
 *   npm run verify:telephony -- --base=https://serviceosapi-...up.railway.app
 *   npm run verify:telephony -- --env=prod       # uses PRODUCTION_API_URL
 *   npm run verify:telephony -- --env=staging    # uses STAGING_API_URL
 *
 * Hits the public, unauthenticated `GET /api/telephony/health` and asserts
 * the three gates that decide whether SMS and click-to-call work end to end:
 *   - outgoing-sms-email  (messageDelivery provider wired)
 *   - click-to-call-host  (PUBLIC_API_URL set)
 *   - database            (threading + per-tenant creds)
 *
 * This is stricter than `npm run smoke-test`, whose telephony probe only
 * checks the endpoint's own `ok` flag — which stays `true` even when SMS
 * sending is off or PUBLIC_API_URL is unset. Exits 0 when all gates pass,
 * 1 otherwise (or on an unreachable host). Safe to run from CI / a Claude
 * Code session after a deploy, provided the host is reachable.
 */
import type { TelephonyHealthReport } from '../src/routes/telephony';
import { evaluateTelephonyConfig } from './telephony-config-verdict';

const FETCH_TIMEOUT_MS = 10_000;

function parseArgs(argv: string[]): { base: string } {
  const args = new Map<string, string>();
  for (const a of argv.slice(2)) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) args.set(m[1], m[2]);
  }
  const base = args.get('base');
  if (base) return { base: base.replace(/\/$/, '') };
  const env = args.get('env');
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
  if (env !== undefined) {
    throw new Error(`Unknown --env "${env}". Expected staging|prod, or use --base=<url>.`);
  }
  return { base: 'http://localhost:3000' };
}

async function main(): Promise<void> {
  const { base } = parseArgs(process.argv);
  const url = `${base}/api/telephony/health`;
  console.log(`Verify telephony config → ${url}`);

  let report: TelephonyHealthReport;
  try {
    const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (res.status !== 200) {
      console.error(`  FAIL — health endpoint returned ${res.status}`);
      console.error(`         body: ${(await res.text()).slice(0, 200)}`);
      process.exit(1);
    }
    report = (await res.json()) as TelephonyHealthReport;
  } catch (err) {
    console.error(`  FAIL — could not reach ${url}: ${(err as Error).message}`);
    process.exit(1);
  }

  const verdict = evaluateTelephonyConfig(report);
  for (const c of verdict.checks) {
    console.log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.name.padEnd(20)} ${c.detail}`);
  }
  if (verdict.warnings.length > 0) {
    console.log('  warnings:');
    for (const w of verdict.warnings) console.log(`    - ${w}`);
  }
  console.log(
    '\n  note: messageDelivery on is the app-level gate. In prod each tenant still needs a\n' +
      '        tenant_integrations row (subaccount + phoneE164 + TENANT_ENCRYPTION_KEY) or its\n' +
      '        per-tenant SMS / inbound signature / click-to-call fail closed.',
  );

  if (!verdict.ok) {
    console.error('\nTelephony config verification FAILED.');
    process.exit(1);
  }
  console.log('\nTelephony config verification passed.');
}

main().catch((err) => {
  console.error('verify-telephony-config crashed:', err);
  process.exit(1);
});
