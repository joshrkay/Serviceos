import { expect, matrixTest, test, type RowHarness } from './helpers/matrix-test';
import { startVoiceSession, voiceInput, approveAndAwaitExecution } from './helpers/voice-flow';

/**
 * VOX-05..VOX-11 — voice-triggered billing funnel + inbox/timeline/session linkage.
 * Real-LLM-only; fails loudly when AI_PROVIDER_API_KEY or execution worker is absent.
 */

test.describe.configure({ mode: 'serial' });

async function voiceProposal(
  h: RowHarness,
  utterance: string,
  label: string,
): Promise<{ sessionId: string; proposalId: string } | null> {
  const { token } = h.tenantA;
  const sessionId = await startVoiceSession(h, token, label);
  if (!sessionId) {
    h.evidence.fail('Voice session could not be started.');
    return null;
  }
  const proposalIds = await voiceInput(h, token, sessionId, utterance, label);
  if (proposalIds.length === 0) {
    h.evidence.fail('Voice utterance produced no proposal (Real-LLM-only).');
    return null;
  }
  return { sessionId, proposalId: proposalIds[0] };
}

matrixTest('VOX-05', 'Voice-triggered estimate draft creation', async (h) => {
  const { token, tenantId, jobId } = h.tenantA;
  const flow = await voiceProposal(
    h,
    `Draft an estimate for job ${jobId} with one diagnostic labor line for $150.`,
    '05',
  );
  if (!flow) return;

  const outcome = await approveAndAwaitExecution(h, token, flow.proposalId, '05');
  if (outcome.status !== 'executed') {
    h.evidence.fail(`Estimate proposal did not execute (status=${outcome.status}).`);
    return;
  }
  if (!outcome.resultEntityId) {
    h.evidence.fail('Estimate proposal executed but returned no resultEntityId.');
    return;
  }
  const db = await h.db.query({
    label: '05-estimate-row',
    tenantId,
    sql: `SELECT id, status FROM estimates WHERE id = $1`,
    params: [outcome.resultEntityId],
  });
  expect(db.rowCount, 'voice-created estimate must exist in DB').toBe(1);
  h.evidence.pass();
});

matrixTest('VOX-06', 'Voice-triggered estimate send transition', async (h) => {
  const { token, tenantId, jobId } = h.tenantA;

  const seed = await h.api.call({
    method: 'POST',
    path: '/api/estimates',
    body: {
      jobId,
      lineItems: [
        {
          id: 'li-send',
          description: 'Tune-up',
          category: 'labor',
          quantity: 1,
          unitPriceCents: 15000,
          totalCents: 15000,
          sortOrder: 0,
          taxable: false,
        },
      ],
      discountCents: 0,
      taxRateBps: 0,
    },
    token,
    label: '06-seed-estimate',
    expectStatus: 201,
  });
  const estimateId = (seed.response.body as { id: string }).id;

  const flow = await voiceProposal(
    h,
    `Please send estimate ${estimateId} to the customer by email.`,
    '06',
  );
  if (!flow) return;

  const outcome = await approveAndAwaitExecution(h, token, flow.proposalId, '06');
  const db = await h.db.query({
    label: '06-estimate-status',
    tenantId,
    sql: `SELECT status FROM estimates WHERE id = $1`,
    params: [estimateId],
  });
  const status = (db.rows[0] as { status?: string })?.status;
  if (outcome.status === 'executed' && status === 'sent') {
    h.evidence.pass('Estimate transitioned to sent after voice send proposal.');
    return;
  }
  h.evidence.fail(
    `Voice send incomplete (proposal=${outcome.status}, estimate=${status ?? 'missing'}).`,
  );
});

matrixTest('VOX-07', 'Voice-triggered invoice creation from sold work', async (h) => {
  const { token, tenantId, jobId } = h.tenantA;
  const flow = await voiceProposal(
    h,
    `Create an invoice for job ${jobId} for the completed furnace repair, $350 total.`,
    '07',
  );
  if (!flow) return;

  const outcome = await approveAndAwaitExecution(h, token, flow.proposalId, '07');
  if (outcome.status !== 'executed') {
    h.evidence.fail(`Invoice create proposal did not execute (status=${outcome.status}).`);
    return;
  }
  const entityId = outcome.resultEntityId;
  if (!entityId) {
    h.evidence.fail('Invoice proposal executed but returned no resultEntityId.');
    return;
  }
  const db = await h.db.query({
    label: '07-invoice-row',
    tenantId,
    sql: `SELECT id, job_id, status FROM invoices WHERE id = $1`,
    params: [entityId],
  });
  expect(db.rowCount, 'voice-created invoice must exist').toBe(1);
  h.evidence.pass();
});

matrixTest('VOX-08', 'Voice-triggered invoice issue transition', async (h) => {
  const { token, tenantId, jobId } = h.tenantA;
  const created = await h.api.call({
    method: 'POST',
    path: '/api/invoices',
    body: {
      jobId,
      lineItems: [
        {
          id: 'li-issue',
          description: 'Repair',
          category: 'labor',
          quantity: 1,
          unitPriceCents: 25000,
          totalCents: 25000,
          sortOrder: 0,
          taxable: false,
        },
      ],
      discountCents: 0,
      taxRateBps: 0,
    },
    token,
    label: '08-seed-invoice',
    expectStatus: 201,
  });
  const invoiceId = (created.response.body as { id: string }).id;

  const flow = await voiceProposal(
    h,
    `Issue invoice ${invoiceId} so the customer can pay.`,
    '08',
  );
  if (!flow) return;

  const outcome = await approveAndAwaitExecution(h, token, flow.proposalId, '08');
  const db = await h.db.query({
    label: '08-invoice-status',
    tenantId,
    sql: `SELECT status, issued_at FROM invoices WHERE id = $1`,
    params: [invoiceId],
  });
  const row = db.rows[0] as { status?: string; issued_at?: string | null };
  if (outcome.status === 'executed' && row.status === 'open' && row.issued_at) {
    h.evidence.pass('Invoice issued (open + issued_at) after voice issue proposal.');
    return;
  }
  h.evidence.fail(
    `Voice issue incomplete (proposal=${outcome.status}, invoice=${row.status ?? 'missing'}).`,
  );
});

matrixTest('VOX-09', 'Voice session visible in interactions timeline', async (h) => {
  const { token, tenantId } = h.tenantA;
  const sessionId = await startVoiceSession(h, token, '09');
  if (!sessionId) {
    h.evidence.fail('Voice session could not be started.');
    return;
  }
  await voiceInput(h, token, sessionId, 'I need to schedule a routine AC maintenance visit.', '09');

  const timeline = await h.api.call({
    method: 'GET',
    path: '/api/interactions?limit=20',
    token,
    label: '09-interactions',
    expectStatus: 200,
  });
  const data = (timeline.response.body as { data?: Array<{ id: string }> }).data ?? [];
  const found = data.some((row) => row.id === sessionId);
  if (!found) {
    h.evidence.fail(`Session ${sessionId} not found in GET /api/interactions.`);
    return;
  }
  await h.db.query({
    label: '09-voice-session-exists',
    tenantId,
    sql: `SELECT id, channel, started_at FROM voice_sessions WHERE id = $1`,
    params: [sessionId],
  });
  h.evidence.pass('Voice session appears in interactions timeline.');
});

matrixTest('VOX-10', 'Voice session artifacts / DB log linkage', async (h) => {
  const { token, tenantId } = h.tenantA;
  const sessionId = await startVoiceSession(h, token, '10');
  if (!sessionId) {
    h.evidence.fail('Voice session could not be started.');
    return;
  }
  await voiceInput(h, token, sessionId, 'What services do you offer for HVAC maintenance?', '10');

  const db = await h.db.query({
    label: '10-voice-session-row',
    tenantId,
    sql: `SELECT id, tenant_id, channel, started_at, ended_at FROM voice_sessions WHERE id = $1`,
    params: [sessionId],
  });
  if (db.rowCount !== 1) {
    h.evidence.fail(`voice_sessions row missing for session ${sessionId}.`);
    return;
  }
  const row = db.rows[0] as { tenant_id: string; channel: string; started_at: string };
  expect(row.tenant_id, 'session tenant_id must match').toBe(tenantId);
  expect(row.channel, 'session channel must be set').toBeTruthy();
  expect(row.started_at, 'session started_at must be set').toBeTruthy();
  h.evidence.pass('voice_sessions row linked to tenant with channel + started_at.');
});

matrixTest('VOX-11', 'Voice-created proposal appears in proposal inbox', async (h) => {
  const { token } = h.tenantA;
  const flow = await voiceProposal(
    h,
    'Add a new customer named Alex Kim, phone 555-555-0199, email alex.kim@example.com.',
    '11',
  );
  if (!flow) return;

  const inbox = await h.api.call({
    method: 'GET',
    path: '/api/proposals/inbox',
    token,
    label: '11-inbox',
    expectStatus: 200,
  });
  const data = (inbox.response.body as { data?: Array<{ id: string }> }).data ?? [];
  const found = data.some((p) => p.id === flow.proposalId);
  if (!found) {
    h.evidence.fail(`Proposal ${flow.proposalId} not found in GET /api/proposals/inbox.`);
    return;
  }
  h.evidence.pass('Voice-created proposal is listed in the proposal inbox.');
});
