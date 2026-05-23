import { test, expect } from '@playwright/test';
import { Client } from 'pg';
import { mintToken } from './fixtures/tokens';

const apiBase = (): string => process.env.E2E_API_URL!.replace(/\/$/, '');

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

// --- Hard gate: minted HMAC tokens must actually authenticate ---
test('precheck — HMAC dev tokens accepted by /api/me', async ({ request }) => {
  const tenantId = process.env.E2E_TENANT_A_ID;
  expect(tenantId, 'E2E_TENANT_A_ID required').toBeTruthy();
  const token = mintToken(tenantId!, 'A');
  const res = await request.get(`${apiBase()}/api/me`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(
    res.status(),
    'GET /api/me must return 200. A 401 almost always means CLERK_DEV_HMAC_TOKENS=true is NOT set on ' +
      'the dev API (it then verifies real Clerk RS256 tokens and rejects our HMAC tokens).'
  ).toBe(200);
  const body = (await res.json()) as { tenant_id?: string; tenantId?: string };
  expect(body.tenant_id ?? body.tenantId, 'token tenant must echo back from /api/me').toBe(tenantId);
});

// --- Informational: capture the live message_dispatches entity_type CHECK ---
test('precheck — message_dispatches entity_type CHECK (informational)', async () => {
  const client = new Client({ connectionString: process.env.E2E_DB_URL_READONLY });
  await client.connect();
  try {
    const res = await client.query(
      `SELECT pg_get_constraintdef(oid) AS def
         FROM pg_constraint WHERE conname = 'message_dispatches_entity_type_check'`
    );
    const def = (res.rows[0]?.def as string) ?? '(constraint not found)';
    console.log('[qa-matrix:precheck] message_dispatches entity_type CHECK =>', def);
    for (const t of ['appointment_reschedule', 'appointment_cancel', 'payment_receipt']) {
      if (!def.includes(t)) {
        console.warn(
          `[qa-matrix:precheck] WARNING entity_type '${t}' is NOT permitted by the live CHECK — ` +
            'its SMS dispatch insert will be rejected (known defect candidate; see SMS-01).'
        );
      }
    }
    expect(res.rowCount ?? 0, 'query should execute').toBeGreaterThanOrEqual(0);
  } finally {
    await client.end();
  }
});

// --- Informational: AI voice classification + execution worker readiness ---
// Voice rows fail loudly on their own; this just surfaces *why* up front.
test('precheck — AI voice + execution worker readiness (informational)', async ({ request }) => {
  const tenantId = process.env.E2E_TENANT_A_ID!;
  const token = mintToken(tenantId, 'A');
  const headers = { authorization: `Bearer ${token}` };

  const start = await request.post(`${apiBase()}/api/voice/sessions`, { headers, data: {} });
  if (![200, 201].includes(start.status())) {
    console.warn(
      `[qa-matrix:precheck] voice session start returned ${start.status()} — voice rows may not run. Body: ${await start.text()}`
    );
    return;
  }
  const sessionId = (await start.json()).sessionId as string;
  const input = await request.post(`${apiBase()}/api/voice/sessions/${sessionId}/input`, {
    headers,
    data: { text: 'I want to add a new customer named Precheck Tester, phone 555 555 0123' },
  });
  const inBody = input.ok() ? ((await input.json()) as { proposalIds?: string[] }) : {};
  const proposalIds = inBody.proposalIds ?? [];
  if (proposalIds.length === 0) {
    console.warn(
      '[qa-matrix:precheck] voice input produced NO proposal — AI_PROVIDER_API_KEY likely unset (mock LLM) ' +
        'or the classifier missed. The voice rows (CUST-02 / SCH-02 / SCH-03) will fail.'
    );
    return;
  }
  console.log(`[qa-matrix:precheck] AI classified → proposal ${proposalIds[0]}; approving to test the worker…`);
  await request.post(`${apiBase()}/api/proposals/${proposalIds[0]}/approve`, { headers, data: {} });

  let status = 'unknown';
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const det = await request.get(`${apiBase()}/api/proposals/${proposalIds[0]}`, { headers });
    if (det.ok()) {
      status = (await det.json()).status;
      if (status === 'executed' || status === 'execution_failed') break;
    }
  }
  if (status === 'executed') {
    console.log('[qa-matrix:precheck] execution worker OK — proposal executed.');
  } else {
    console.warn(
      `[qa-matrix:precheck] proposal did not reach 'executed' (last=${status}). ` +
        'The runExecutionSweep worker may not be running on the dev API.'
    );
  }
});
