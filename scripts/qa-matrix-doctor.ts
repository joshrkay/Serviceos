#!/usr/bin/env tsx
/**
 * qa-matrix-doctor — pre-flight checker for the 4-agent QA matrix harness.
 *
 * Walks every env var the matrix needs (see e2e/qa-matrix/README.md), and for
 * each one that is set, runs a smoke probe to confirm it actually works:
 *   - E2E_BASE_URL          -> HTTP GET, expect 200
 *   - E2E_API_URL           -> HTTP GET /health, expect 200
 *   - E2E_DB_URL_READONLY   -> connect + SELECT 1
 *   - E2E_DB_URL_READWRITE  -> connect + SELECT 1 (seeder uses this)
 *   - E2E_CLERK_HMAC_SECRET -> non-empty + minimum length
 *   - E2E_TENANT_*          -> non-empty UUID-shaped string
 *
 * Prints a checklist with [OK] / [FAIL] / [skip] per var. Exits 1 if any
 * REQUIRED var is missing or any probe fails (so this is safe to chain into
 * `npm run e2e:qa-matrix`).
 *
 * Usage:
 *   npx tsx scripts/qa-matrix-doctor.ts
 *   npm run qa:doctor
 */

import { Client } from 'pg';

type Status = 'OK' | 'FAIL' | 'skip';

interface CheckResult {
  name: string;
  status: Status;
  detail: string;
  required: boolean;
}

const REQUIRED_VARS = [
  'E2E_BASE_URL',
  'E2E_API_URL',
  'E2E_DB_URL_READONLY',
  'E2E_DB_URL_READWRITE',
  'E2E_CLERK_HMAC_SECRET',
  'E2E_TENANT_A_ID',
  'E2E_TENANT_A_CUSTOMER_ID',
  'E2E_TENANT_A_JOB_ID',
  'E2E_TENANT_B_ID',
  'E2E_TENANT_B_CUSTOMER_ID',
  'E2E_TENANT_B_JOB_ID',
] as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLACEHOLDER_RE = /<.+>/;
const HTTP_TIMEOUT_MS = 8_000;
const DB_TIMEOUT_MS = 10_000;

function symbol(status: Status): string {
  if (status === 'OK') return '[OK]  ';
  if (status === 'FAIL') return '[FAIL]';
  return '[skip]';
}

function present(name: string): boolean {
  const v = process.env[name];
  return typeof v === 'string' && v.length > 0;
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

async function checkEnvVar(name: string): Promise<CheckResult> {
  const required = (REQUIRED_VARS as readonly string[]).includes(name);
  const value = process.env[name];

  if (!value) {
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

  // URL checks
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

  // DB checks
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

  // HMAC secret
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

  // Tenant / customer / job ids: must be UUIDs (matches seed.ts which uses randomUUID()).
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

async function main(): Promise<void> {
  console.log('qa-matrix doctor — pre-flight checks for the 4-agent QA matrix\n');

  const allVars = [...REQUIRED_VARS];
  const results: CheckResult[] = [];

  for (const name of allVars) {
    // Probes that touch network/DB take a few seconds each; we keep them serial
    // so the output renders top-to-bottom in env-order rather than racing.
    // eslint-disable-next-line no-await-in-loop
    const r = await checkEnvVar(name);
    results.push(r);
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
    console.log('See qa/reports/2026-05-11/qa-matrix-live-runbook.md for setup instructions.');
    process.exit(1);
  }

  console.log('');
  console.log('All required env vars set and reachable. Ready for: npm run e2e:qa-matrix');
}

main().catch((err) => {
  console.error('qa-matrix doctor crashed:', err);
  process.exit(2);
});
