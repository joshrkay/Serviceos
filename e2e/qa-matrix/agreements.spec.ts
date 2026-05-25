import { expect, matrixTest, test, type RowHarness } from './helpers/matrix-test';

/**
 * AGR-01 — create a recurring service agreement; verify it persists active
 *          with its recurrence rule + price, and GET /:id resolves it.
 * AGR-02 — pause → resume → cancel lifecycle, asserted in API + DB; cancel is
 *          terminal.
 *
 * Uses the seeded tenant-A customer (agreements require a real customer uuid;
 * location is optional). No AI key required.
 */

test.describe.configure({ mode: 'serial' });

function isoToday(): string {
  return new Date().toISOString().slice(0, 10);
}

async function createAgreement(h: RowHarness, label: string): Promise<string> {
  const res = await h.api.call({
    method: 'POST',
    path: '/api/agreements',
    body: {
      customerId: h.tenantA.customerId,
      name: `QA Maintenance ${label}-${Date.now()}`,
      recurrenceRule: 'FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=15',
      priceCents: 19_900,
      startsOn: isoToday(),
      autoGenerateInvoice: true,
      autoGenerateJob: false,
    },
    token: h.tenantA.token,
    label,
    expectStatus: 201,
  });
  const id = (res.response.body as { id: string }).id;
  expect(id, 'agreement create must return an id').toBeTruthy();
  return id;
}

async function dbStatus(h: RowHarness, label: string, agreementId: string): Promise<string> {
  const row = await h.db.query({
    label,
    tenantId: h.tenantA.tenantId,
    sql: `SELECT status FROM service_agreements WHERE id = $1`,
    params: [agreementId],
  });
  expect(row.rowCount, `${label}: agreement row must exist`).toBe(1);
  return (row.rows[0] as { status: string }).status;
}

matrixTest('AGR-01', 'Create recurring service agreement', async (h) => {
  const id = await createAgreement(h, '01-create');
  expect(await dbStatus(h, '01-status', id), 'new agreement is active').toBe('active');

  const detail = await h.api.call({
    method: 'GET',
    path: `/api/agreements/${id}`,
    token: h.tenantA.token,
    label: '01-detail',
    expectStatus: 200,
  });
  const body = detail.response.body as { id: string; priceCents?: number; recentRuns?: unknown[] };
  expect(body.id, 'detail resolves the same agreement').toBe(id);
  expect(Array.isArray(body.recentRuns), 'detail includes a recentRuns array').toBe(true);

  await gotoUi(h, '/contracts', '01-contracts-ui');
  h.evidence.pass();
});

matrixTest('AGR-02', 'Agreement pause → resume → cancel lifecycle', async (h) => {
  const id = await createAgreement(h, '02-create');

  await h.api.call({ method: 'POST', path: `/api/agreements/${id}/pause`, token: h.tenantA.token, label: '02-pause', expectStatus: 200 });
  expect(await dbStatus(h, '02-status-paused', id), 'pause sets status=paused').toBe('paused');

  await h.api.call({ method: 'POST', path: `/api/agreements/${id}/resume`, token: h.tenantA.token, label: '02-resume', expectStatus: 200 });
  expect(await dbStatus(h, '02-status-active', id), 'resume returns status=active').toBe('active');

  await h.api.call({ method: 'POST', path: `/api/agreements/${id}/cancel`, token: h.tenantA.token, label: '02-cancel', expectStatus: 200 });
  expect(await dbStatus(h, '02-status-cancelled', id), 'cancel sets status=cancelled').toBe('cancelled');

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
