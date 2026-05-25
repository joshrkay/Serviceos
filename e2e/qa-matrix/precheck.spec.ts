import { test, expect } from '@playwright/test';
import { Client } from 'pg';
import { apiBase, tenantA } from './fixtures/tokens';

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

test('precheck — minted tenant token can call /api/me (CLERK_DEV_HMAC_TOKENS path active)', async ({ request }) => {
  const t = tenantA();
  const me = await request.get(`${apiBase().replace(/\/$/, '')}/api/me`, {
    headers: { Authorization: `Bearer ${t.token}` },
  });

  expect(me.status(), `Expected 200 from /api/me using minted HMAC tenant token; got ${me.status()}.`).toBe(200);
});

test('precheck — voice utterance generates proposal IDs (non-mock LLM path)', async ({ request }) => {
  const t = tenantA();
  const base = apiBase().replace(/\/$/, '');

  const create = await request.post(`${base}/api/voice/sessions`, {
    headers: { Authorization: `Bearer ${t.token}` },
    data: { channel: 'qa-precheck' },
  });
  expect([200, 201], `Unexpected create session status: ${create.status()}`).toContain(create.status());

  const created = (await create.json()) as { id?: string; sessionId?: string };
  const sessionId = created.id ?? created.sessionId;
  expect(sessionId, `Voice session create response did not include id/sessionId: ${JSON.stringify(created)}`).toBeTruthy();

  const utter = await request.post(`${base}/api/voice/sessions/${sessionId}/utterances`, {
    headers: { Authorization: `Bearer ${t.token}` },
    data: {
      text: `Create an estimate proposal for job ${t.jobId} with diagnostic labor line item for $125 total.`,
      source: 'qa-precheck',
    },
  });
  expect([200, 201], `Unexpected utterance status: ${utter.status()}`).toContain(utter.status());

  const utterBody = (await utter.json()) as {
    proposalIds?: string[];
    proposals?: Array<{ id: string }>;
  };
  const proposalIds = utterBody.proposalIds ?? utterBody.proposals?.map((p) => p.id) ?? [];
  expect(
    proposalIds.length,
    `Expected utterance to return at least one proposal id (non-mock LLM signal). Body=${JSON.stringify(utterBody)}`
  ).toBeGreaterThanOrEqual(1);
});

test('precheck — approved proposal transitions to executed after undo window', async ({ request }) => {
  const t = tenantA();
  const base = apiBase().replace(/\/$/, '');

  const draft = await request.post(`${base}/api/assistant/chat`, {
    headers: { Authorization: `Bearer ${t.token}` },
    data: {
      messages: [
        {
          role: 'user',
          content: `Draft an estimate for job ${t.jobId} with one labor item for $99 and return the proposal.`,
        },
      ],
    },
  });
  expect(draft.status(), `Expected assistant chat 200, got ${draft.status()}.`).toBe(200);

  const draftBody = (await draft.json()) as {
    message?: { proposal?: { id?: string } };
    proposal?: { id?: string };
  };
  const proposalId = draftBody.message?.proposal?.id ?? draftBody.proposal?.id;
  expect(proposalId, `No proposal id found in assistant response: ${JSON.stringify(draftBody)}`).toBeTruthy();

  const approve = await request.post(`${base}/api/proposals/${proposalId}/approve`, {
    headers: { Authorization: `Bearer ${t.token}` },
    data: {},
  });
  expect([200, 202], `Unexpected proposal approve status: ${approve.status()}`).toContain(approve.status());

  await new Promise((resolve) => setTimeout(resolve, 6_500));

  const timeoutMs = 45_000;
  const start = Date.now();
  let latestStatus = 'unknown';
  while (Date.now() - start < timeoutMs) {
    const statusRes = await request.get(`${base}/api/proposals/${proposalId}`, {
      headers: { Authorization: `Bearer ${t.token}` },
    });
    expect(statusRes.status(), `Failed fetching proposal status for ${proposalId}.`).toBe(200);
    const body = (await statusRes.json()) as { status?: string };
    latestStatus = body.status ?? 'missing';
    if (latestStatus === 'executed') break;
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }

  expect(
    latestStatus,
    `Proposal ${proposalId} did not reach executed within ${timeoutMs}ms after undo window elapsed.`
  ).toBe('executed');
});

test('precheck — capture message_dispatches entity_type check constraint definition', async () => {
  const client = new Client({ connectionString: process.env.E2E_DB_URL_READONLY });
  await client.connect();
  try {
    const res = await client.query(
      `SELECT c.conname, pg_get_constraintdef(c.oid) AS definition
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE n.nspname = 'public'
         AND t.relname = 'message_dispatches'
         AND c.contype = 'c'
         AND pg_get_constraintdef(c.oid) ILIKE '%entity_type%'
       ORDER BY c.conname`
    );

    expect(
      res.rowCount,
      'No message_dispatches CHECK constraint containing entity_type found in pg_constraint catalog.'
    ).toBeGreaterThan(0);

    const defs = res.rows.map((r) => `${r.conname}: ${r.definition}`);
    test.info().annotations.push({
      type: 'evidence',
      description: `message_dispatches entity_type CHECK => ${defs.join(' | ')}`,
    });
    console.log(`[precheck evidence] message_dispatches entity_type CHECK => ${defs.join(' | ')}`);
  } finally {
    await client.end();
  }
});
