import { test, expect } from '@playwright/test';
import { Client } from 'pg';

/**
 * Fails fast if prerequisites are missing so matrix rows don't produce
 * misleading "fail" artifacts from plumbing issues.
 */

const REQUIRED_ENV = [
  'E2E_BASE_URL',
  'E2E_API_URL',
  'E2E_DB_URL_READONLY',
  'E2E_CLERK_HMAC_SECRET',
  'E2E_TENANT_A_ID',
  'E2E_TENANT_A_CUSTOMER_ID',
  'E2E_TENANT_A_JOB_ID',
  'E2E_TENANT_B_ID',
  'E2E_TENANT_B_CUSTOMER_ID',
  'E2E_TENANT_B_JOB_ID',
];

test('precheck — required env vars are set', () => {
  const missing = REQUIRED_ENV.filter((v) => !process.env[v]);
  expect(missing, `Missing env: ${missing.join(', ')}. See qa/README.md.`).toEqual([]);
});

test('precheck — URLs are well-formed', () => {
  for (const name of ['E2E_BASE_URL', 'E2E_API_URL'] as const) {
    const v = process.env[name];
    expect(v, `${name} is empty`).toBeTruthy();
    try {
      // Catches literal placeholders like `https://<your-api-service>.up.railway.app`.
      // Also catches typos like a missing scheme.
      new URL(v!);
    } catch (err) {
      throw new Error(`${name} is not a valid URL: "${v}". ${(err as Error).message}`);
    }
    expect(v!.includes('<'), `${name} looks like a placeholder (contains "<"): ${v}`).toBe(false);
  }
});

test('precheck — API /health responds 200', async ({ request }) => {
  const apiUrl = process.env.E2E_API_URL!;
  const res = await request.get(`${apiUrl.replace(/\/$/, '')}/health`);
  expect(res.status()).toBe(200);
});

test('precheck — DB is reachable and has tenants/estimates/invoices tables', async () => {
  const client = new Client({ connectionString: process.env.E2E_DB_URL_READONLY });
  await client.connect();
  try {
    const res = await client.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name IN ('tenants','estimates','invoices','customers','jobs')`
    );
    const found = new Set(res.rows.map((r) => r.table_name));
    for (const t of ['tenants', 'estimates', 'invoices', 'customers', 'jobs']) {
      expect(found, `Missing table: ${t}`).toContain(t);
    }
  } finally {
    await client.end();
  }
});
