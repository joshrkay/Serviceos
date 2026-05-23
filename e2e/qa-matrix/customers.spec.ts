import { expect, matrixTest, test, type RowHarness } from './helpers/matrix-test';
import { startVoiceSession, voiceInput, approveAndAwaitExecution } from './helpers/voice-flow';

/**
 * CUST-01 — create customers in-app (2 per tenant) via POST /api/customers.
 * CUST-02 — create a customer via the AI voice session (Real-LLM-only):
 *           utterance → create_customer proposal → approve → executed → row.
 */

test.describe.configure({ mode: 'serial' });

function customerBody(tag: string) {
  const stamp = Date.now();
  return {
    firstName: 'QA',
    lastName: `${tag}-${stamp}`,
    primaryPhone: `+1555${String(stamp).slice(-7)}`,
    email: `qa+${tag}-${stamp}@example.com`,
    preferredChannel: 'sms',
    smsConsent: true,
  };
}

async function createInApp(h: RowHarness, token: string, tenantId: string, tag: string, label: string): Promise<void> {
  const res = await h.api.call({
    method: 'POST',
    path: '/api/customers',
    body: customerBody(tag),
    token,
    label,
    expectStatus: 201,
  });
  const id = (res.response.body as { id?: string }).id;
  expect(id, `${label}: response must include id`).toBeTruthy();

  const db = await h.db.query({
    label: `${label}-row`,
    tenantId,
    sql: `SELECT id, tenant_id, first_name FROM customers WHERE id = $1`,
    params: [id],
  });
  expect(db.rowCount, `${label}: customer row must exist under tenant`).toBe(1);
}

matrixTest('CUST-01', 'Create customers in-app (both tenants)', async (h) => {
  // Two for Tenant A, two for Tenant B.
  await createInApp(h, h.tenantA.token, h.tenantA.tenantId, 'A1', '01-a1');
  await createInApp(h, h.tenantA.token, h.tenantA.tenantId, 'A2', '01-a2');
  await createInApp(h, h.tenantB.token, h.tenantB.tenantId, 'B1', '01-b1');
  await createInApp(h, h.tenantB.token, h.tenantB.tenantId, 'B2', '01-b2');

  await gotoUi(h, '/customers', '01-list-ui');
  h.evidence.pass();
});

matrixTest('CUST-02', 'Create customer via AI voice session', async (h) => {
  const { token, tenantId } = h.tenantA;
  const t0 = new Date(Date.now() - 5000).toISOString();

  const sessionId = await startVoiceSession(h, token, '02');
  if (!sessionId) {
    h.evidence.fail('Voice session could not be started (POST /api/voice/sessions did not return a sessionId).');
    return;
  }

  const proposalIds = await voiceInput(
    h,
    token,
    sessionId,
    'I want to add a new customer named Dana Rivera, phone 555 555 0144, email dana.rivera@example.com',
    '02'
  );
  if (proposalIds.length === 0) {
    h.evidence.fail(
      'Voice utterance produced no proposal — AI_PROVIDER_API_KEY is likely unset (mock LLM) or the ' +
        'classifier did not map customer creation. (Real-LLM-only QA mode.)'
    );
    return;
  }

  const outcome = await approveAndAwaitExecution(h, token, proposalIds[0], '02');
  if (outcome.status !== 'executed') {
    h.evidence.fail(
      `create_customer proposal did not execute (status=${outcome.status}). ` +
        'Check the runExecutionSweep worker on the dev API.'
    );
    return;
  }

  // The executed proposal should have produced a customer row.
  if (outcome.resultEntityId) {
    const db = await h.db.query({
      label: '02-created-row',
      tenantId,
      sql: `SELECT id, first_name, last_name FROM customers WHERE id = $1`,
      params: [outcome.resultEntityId],
    });
    expect(db.rowCount, 'voice-created customer row must exist').toBe(1);
  } else {
    // Scope to rows created during this test so a stale 'Dana Rivera' from a
    // prior run can't mask a regression in the voice execution path.
    const db = await h.db.query({
      label: '02-created-by-name',
      tenantId,
      sql: `SELECT id FROM customers WHERE tenant_id = $1 AND first_name = 'Dana' AND last_name = 'Rivera' AND created_at >= $2`,
      params: [tenantId, t0],
    });
    expect(db.rowCount, 'voice-created customer (by name, this run) must exist').toBeGreaterThanOrEqual(1);
  }

  await gotoUi(h, '/customers', '02-list-ui');
  h.evidence.pass();
});

// ---------------- helpers ----------------

async function gotoUi(h: RowHarness, path: string, label: string): Promise<void> {
  const baseUrl = process.env.E2E_BASE_URL!;
  try {
    await h.page.goto(`${baseUrl}${path}`, { waitUntil: 'domcontentloaded' });
  } catch (err) {
    h.evidence.note(`navigation to ${path} failed: ${(err as Error).message}`);
  }
  await h.page.waitForTimeout(500);
  await h.snapshot(label);
}
