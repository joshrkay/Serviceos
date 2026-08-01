#!/usr/bin/env tsx
/**
 * qa-matrix-doctor — pre-flight checker for the 4-agent QA matrix harness.
 *
 * Walks every env var the matrix needs (see qa/README.md), and for each one
 * that is set, runs a smoke probe to confirm it actually works:
 *   - E2E_BASE_URL          -> HTTP GET, expect 200
 *   - E2E_API_URL           -> HTTP GET /health, expect 200
 *   - E2E_DB_URL_READONLY   -> connect + SELECT 1
 *   - E2E_DB_URL_READWRITE  -> connect + SELECT 1 (seeder uses this)
 *   - E2E_CLERK_HMAC_SECRET -> non-empty + minimum length
 *   - E2E_TENANT_*          -> non-empty UUID-shaped string
 *
 * Full mode (default): all 11 vars required; optional HMAC /api/me probe when
 * tenant IDs are present.
 *
 * Bootstrap mode (`--bootstrap`): only URLs + DB + HMAC secret required;
 * tenant UUID vars may be unset (run `npm run qa:setup` first).
 *
 * Usage:
 *   npx tsx scripts/qa-matrix-doctor.ts
 *   npm run qa:doctor
 *   npm run qa:doctor:bootstrap
 */

import { Client } from 'pg';
import { mintHmacJwt } from './qa-hmac-mint';

type Status = 'OK' | 'FAIL' | 'skip';

export interface CheckResult {
  name: string;
  status: Status;
  detail: string;
  required: boolean;
}

export const BOOTSTRAP_REQUIRED_VARS = [
  'E2E_BASE_URL',
  'E2E_API_URL',
  'E2E_DB_URL_READONLY',
  'E2E_DB_URL_READWRITE',
  'E2E_CLERK_HMAC_SECRET',
] as const;

export const TENANT_VARS = [
  'E2E_TENANT_A_ID',
  'E2E_TENANT_A_CUSTOMER_ID',
  'E2E_TENANT_A_JOB_ID',
  'E2E_TENANT_B_ID',
  'E2E_TENANT_B_CUSTOMER_ID',
  'E2E_TENANT_B_JOB_ID',
] as const;

export const FULL_REQUIRED_VARS = [
  ...BOOTSTRAP_REQUIRED_VARS,
  ...TENANT_VARS,
] as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLACEHOLDER_RE = /<.+>/;
const HTTP_TIMEOUT_MS = 8_000;
const DB_TIMEOUT_MS = 10_000;

const HMAC_PROBE_HINT =
  'Likely causes: (1) CLERK_DEV_HMAC_TOKENS=true not set on the deployed API, ' +
  '(2) E2E_CLERK_HMAC_SECRET drifted from CLERK_SECRET_KEY, ' +
  '(3) NODE_ENV=production on the API (HMAC path refused).';

export function parseBootstrapFlag(argv: string[] = process.argv): boolean {
  return argv.includes('--bootstrap');
}

export function requiredVarSet(bootstrap: boolean): ReadonlySet<string> {
  return new Set(bootstrap ? BOOTSTRAP_REQUIRED_VARS : FULL_REQUIRED_VARS);
}

export function allCheckedVars(): readonly string[] {
  return FULL_REQUIRED_VARS;
}

function symbol(status: Status): string {
  if (status === 'OK') return '[OK]  ';
  if (status === 'FAIL') return '[FAIL]';
  return '[skip]';
}

function looksPlaceholder(value: string): boolean {
  return PLACEHOLDER_RE.test(value);
}

async function probeHttp(url: string, expectPath = ''): Promise<{ ok: boolean; detail: string }> {
  const target = `${url.replace(/\/$/, '')}${expectPath}`;
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), HTTP_TIMEOUT_MS);
    const res = await fetch(target, { method: 'GET', signal: ac.signal });
    clearTimeout(timer);
    if (res.status === 200) {
      return { ok: true, detail: `200 OK from ${target}` };
    }
    return { ok: false, detail: `expected 200, got ${res.status} from ${target}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: `fetch failed for ${target}: ${msg}` };
  }
}

async function probeDb(connStr: string): Promise<{ ok: boolean; detail: string }> {
  let client: Client | null = null;
  try {
    client = new Client({
      connectionString: connStr,
      statement_timeout: DB_TIMEOUT_MS,
      connectionTimeoutMillis: DB_TIMEOUT_MS,
    });
    await client.connect();
    const res = await client.query('SELECT 1 as ok');
    if (res.rows?.[0]?.ok === 1) {
      return { ok: true, detail: 'connected, SELECT 1 returned 1' };
    }
    return { ok: false, detail: `SELECT 1 returned unexpected value: ${JSON.stringify(res.rows)}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: `pg connect failed: ${msg}` };
  } finally {
    if (client) {
      try {
        await client.end();
      } catch {
        /* swallow */
      }
    }
  }
}

export async function checkEnvVar(
  name: string,
  required: boolean,
  bootstrap: boolean,
): Promise<CheckResult> {
  const value = process.env[name];

  if (!value) {
    if (!required && bootstrap && (TENANT_VARS as readonly string[]).includes(name)) {
      return {
        name,
        status: 'skip',
        detail: 'not set (run npm run qa:setup first)',
        required: false,
      };
    }
    return {
      name,
      status: required ? 'FAIL' : 'skip',
      detail: required ? 'not set (required)' : 'not set (optional, skipped)',
      required,
    };
  }

  if (looksPlaceholder(value)) {
    return {
      name,
      status: 'FAIL',
      detail: `value contains a placeholder ("<...>"): ${value}`,
      required,
    };
  }

  if (name === 'E2E_BASE_URL') {
    try {
      new URL(value);
    } catch {
      return { name, status: 'FAIL', detail: `not a valid URL: ${value}`, required };
    }
    const probe = await probeHttp(value);
    return {
      name,
      status: probe.ok ? 'OK' : 'FAIL',
      detail: probe.detail,
      required,
    };
  }

  if (name === 'E2E_API_URL') {
    try {
      new URL(value);
    } catch {
      return { name, status: 'FAIL', detail: `not a valid URL: ${value}`, required };
    }
    const probe = await probeHttp(value, '/health');
    return {
      name,
      status: probe.ok ? 'OK' : 'FAIL',
      detail: probe.detail,
      required,
    };
  }

  if (name === 'E2E_DB_URL_READONLY' || name === 'E2E_DB_URL_READWRITE') {
    if (!value.startsWith('postgres://') && !value.startsWith('postgresql://')) {
      return {
        name,
        status: 'FAIL',
        detail: `expected postgres:// or postgresql:// scheme, got: ${value.slice(0, 16)}…`,
        required,
      };
    }
    const probe = await probeDb(value);
    return {
      name,
      status: probe.ok ? 'OK' : 'FAIL',
      detail: probe.detail,
      required,
    };
  }

  if (name === 'E2E_CLERK_HMAC_SECRET') {
    if (value.length < 16) {
      return {
        name,
        status: 'FAIL',
        detail: `looks too short (${value.length} chars). Expect a Clerk secret like sk_test_… or a 32+ char HMAC.`,
        required,
      };
    }
    return {
      name,
      status: 'OK',
      detail: `${value.length} chars; first 4: "${value.slice(0, 4)}…"`,
      required,
    };
  }

  if (name.startsWith('E2E_TENANT_')) {
    if (!UUID_RE.test(value)) {
      return {
        name,
        status: 'FAIL',
        detail: `not a UUID (seed.ts emits randomUUID()): "${value}"`,
        required,
      };
    }
    return { name, status: 'OK', detail: `UUID ${value.slice(0, 8)}…`, required };
  }

  return { name, status: 'OK', detail: `set (${value.length} chars)`, required };
}

export async function probeHmacAuth(): Promise<CheckResult> {
  const secret = process.env.E2E_CLERK_HMAC_SECRET;
  const tenantA = process.env.E2E_TENANT_A_ID;
  const apiUrl = process.env.E2E_API_URL;

  if (!secret || !tenantA || !apiUrl) {
    return {
      name: 'HMAC_AUTH_PROBE',
      status: 'skip',
      detail: 'skipped (need E2E_CLERK_HMAC_SECRET, E2E_TENANT_A_ID, E2E_API_URL)',
      required: false,
    };
  }

  const token = mintHmacJwt(secret, tenantA, 'doctor-probe');
  const target = `${apiUrl.replace(/\/$/, '')}/api/me`;
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), HTTP_TIMEOUT_MS);
    const res = await fetch(target, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      signal: ac.signal,
    });
    clearTimeout(timer);
    if (res.status === 200) {
      return {
        name: 'HMAC_AUTH_PROBE',
        status: 'OK',
        detail: `200 OK from ${target}`,
        required: true,
      };
    }
    return {
      name: 'HMAC_AUTH_PROBE',
      status: 'FAIL',
      detail: `GET ${target} returned ${res.status}. ${HMAC_PROBE_HINT}`,
      required: true,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      name: 'HMAC_AUTH_PROBE',
      status: 'FAIL',
      detail: `fetch failed for ${target}: ${msg}`,
      required: true,
    };
  }
}

export async function runDoctor(opts: { bootstrap?: boolean } = {}): Promise<CheckResult[]> {
  const bootstrap = opts.bootstrap ?? parseBootstrapFlag();
  const required = requiredVarSet(bootstrap);
  const results: CheckResult[] = [];

  for (const name of allCheckedVars()) {
    // eslint-disable-next-line no-await-in-loop
    const r = await checkEnvVar(name, required.has(name), bootstrap);
    results.push(r);
  }

  if (!bootstrap) {
    results.push(await probeHmacAuth());
  }

  return results;
}

async function main(): Promise<void> {
  const bootstrap = parseBootstrapFlag();
  const modeLabel = bootstrap ? 'bootstrap (URLs + DB + HMAC secret)' : 'full matrix';
  console.log(`qa-matrix doctor — pre-flight checks for the 4-agent QA matrix (${modeLabel})\n`);

  const results = await runDoctor({ bootstrap });

  for (const r of results) {
    console.log(`${symbol(r.status)} ${r.name.padEnd(30)} ${r.detail}`);
  }

  const failures = results.filter((r) => r.status === 'FAIL');
  const skipped = results.filter((r) => r.status === 'skip');
  const passed = results.filter((r) => r.status === 'OK');

  console.log('');
  console.log(`Summary: ${passed.length} OK, ${failures.length} FAIL, ${skipped.length} skip`);

  if (failures.length > 0) {
    console.log('');
    console.log('Failures:');
    for (const f of failures) {
      console.log(`  - ${f.name}: ${f.detail}`);
    }
    console.log('');
    console.log('See docs/runbooks/qa-full-matrix-unblock.md for setup instructions.');
    process.exit(1);
  }

  console.log('');
  if (bootstrap) {
    console.log('Bootstrap checks passed. Run: npm run qa:setup');
  } else {
    console.log('All required env vars set and reachable. Ready for: npm run e2e:qa-matrix');
  }
}

const isMain =
  typeof process.argv[1] === 'string' &&
  (process.argv[1].endsWith('qa-matrix-doctor.ts') ||
    process.argv[1].endsWith('qa-matrix-doctor'));

if (isMain) {
  main().catch((err) => {
    console.error('qa-matrix doctor crashed:', err);
    process.exit(2);
  });
}
