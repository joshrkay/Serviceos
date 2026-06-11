import { expect, matrixTest, test, type RowHarness } from './helpers/matrix-test';

/**
 * LEAD-01 — a lead created via public intake is walked through the pipeline
 *           (new → contacted → qualified → won) with PATCH, DB-verified.
 * LEAD-02 — POST /:id/lose with a reason sets stage=lost + lost_reason.
 *
 * Self-contained: each row creates its own lead via the unauthenticated
 * intake endpoint, then drives it with the authed tenant-A token.
 */

test.describe.configure({ mode: 'serial' });

async function createLead(h: RowHarness, label: string): Promise<string> {
  const stamp = Date.now();
  const res = await h.api.call({
    method: 'POST',
    path: `/public/intake/${h.tenantA.tenantId}/leads`,
    body: {
      firstName: 'Pipe',
      lastName: `Line-${label}-${stamp}`,
      primaryPhone: `+1555${String(stamp).slice(-7)}`,
      serviceType: 'HVAC',
      description: 'pipeline QA',
    },
    label: `${label}-intake`,
    expectStatus: 201,
  });
  const leadId = (res.response.body as { leadId: string }).leadId;
  expect(leadId, 'intake must return a leadId').toBeTruthy();
  return leadId;
}

async function dbLead(h: RowHarness, label: string, leadId: string): Promise<{ stage: string; lost_reason: string | null }> {
  const row = await h.db.query({
    label,
    tenantId: h.tenantA.tenantId,
    sql: `SELECT stage, lost_reason FROM leads WHERE id = $1`,
    params: [leadId],
  });
  expect(row.rowCount, `${label}: lead row must exist`).toBe(1);
  return row.rows[0] as { stage: string; lost_reason: string | null };
}

matrixTest('LEAD-01', 'Lead stage progression + won-guard', async (h) => {
  const leadId = await createLead(h, '01');
  expect((await dbLead(h, '01-stage-new', leadId)).stage, 'lead starts in `new`').toBe('new');

  // Lateral kanban moves up to `quoted` are allowed via PATCH.
  for (const stage of ['contacted', 'qualified', 'quoted'] as const) {
    await h.api.call({
      method: 'PATCH',
      path: `/api/leads/${leadId}`,
      body: { stage },
      token: h.tenantA.token,
      label: `01-to-${stage}`,
      expectStatus: 200,
    });
    expect((await dbLead(h, `01-stage-${stage}`, leadId)).stage, `lead must persist stage=${stage}`).toBe(stage);
  }

  // Promotion to `won` must go through convertToCustomer, not a raw stage
  // PATCH — the engine refuses it (400) so the customer row + audit chain
  // stay atomic.
  const won = await h.api.call({
    method: 'PATCH',
    path: `/api/leads/${leadId}`,
    body: { stage: 'won' },
    token: h.tenantA.token,
    label: '01-to-won-refused',
  });
  expect(won.response.status, 'setting stage=won directly must be refused (400)').toBe(400);
  expect((await dbLead(h, '01-stage-after-won', leadId)).stage, 'refused won-PATCH leaves lead at quoted').toBe('quoted');

  await gotoUi(h, '/leads', '01-leads-ui');
  h.evidence.pass();
});

matrixTest('LEAD-02', 'Lead lost with reason', async (h) => {
  const leadId = await createLead(h, '02');
  await h.api.call({
    method: 'POST',
    path: `/api/leads/${leadId}/lose`,
    body: { reason: 'Chose another contractor' },
    token: h.tenantA.token,
    label: '02-lose',
    expectStatus: 200,
  });
  const row = await dbLead(h, '02-stage-lost', leadId);
  expect(row.stage, 'lost lead must persist stage=lost').toBe('lost');
  expect(row.lost_reason, 'lost lead must record the reason').toBe('Chose another contractor');
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
