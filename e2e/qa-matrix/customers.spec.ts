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

  // Matrix pass criteria requires creation with result_entity_id — fail if the
  // executed proposal didn't surface one (no name-match fallback, which a stale
  // row from a prior run could satisfy).
  if (!outcome.resultEntityId) {
    h.evidence.fail('create_customer executed but returned no resultEntityId; cannot confirm a customer was created.');
    return;
  }
  const db = await h.db.query({
    label: '02-created-row',
    tenantId,
    sql: `SELECT id, first_name, last_name FROM customers WHERE id = $1`,
    params: [outcome.resultEntityId],
  });
  expect(db.rowCount, 'voice-created customer row must exist').toBe(1);

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
