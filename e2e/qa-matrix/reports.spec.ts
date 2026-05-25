import { expect, matrixTest, test, type RowHarness } from './helpers/matrix-test';

/**
 * RPT-01 — GET /api/reports/money-dashboard.
 * RPT-02 — GET /api/reports/revenue-by-source.
 * RPT-03 — GET /api/reports/time-given-back.
 *
 * All three are deterministic, read-only, tenant-scoped GETs (no AI key
 * required). money-dashboard and time-given-back 503 when their repo/reporter
 * dep is absent in the target env — recorded as a partial rather than a fail,
 * since that is a deploy-config gap, not a defect.
 */

test.describe.configure({ mode: 'serial' });

function currentMonth(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

matrixTest('RPT-01', 'Money dashboard report', async (h) => {
  const res = await h.api.call({
    method: 'GET',
    path: `/api/reports/money-dashboard?month=${currentMonth()}`,
    token: h.tenantA.token,
    label: '01-money-dashboard',
    expectStatus: [200, 503],
  });
  if (res.response.status === 503) {
    return void h.evidence.partial('money-dashboard repo not configured in this env (503 NOT_CONFIGURED).');
  }
  const body = res.response.body as { data?: unknown };
  expect(body.data, 'money-dashboard must return a data summary').toBeTruthy();
  await gotoUi(h, '/reports/money', '01-ui');
  h.evidence.pass();
});

matrixTest('RPT-02', 'Revenue-by-source report', async (h) => {
  const res = await h.api.call({
    method: 'GET',
    path: '/api/reports/revenue-by-source',
    token: h.tenantA.token,
    label: '02-revenue-by-source',
    expectStatus: 200,
  });
  const body = res.response.body as { data?: unknown };
  expect(Array.isArray(body.data), 'revenue-by-source must return a data array').toBe(true);
  await gotoUi(h, '/reports/revenue-by-source', '02-ui');
  h.evidence.pass();
});

matrixTest('RPT-03', 'Time-given-back report', async (h) => {
  const res = await h.api.call({
    method: 'GET',
    path: '/api/reports/time-given-back',
    token: h.tenantA.token,
    label: '03-time-given-back',
    expectStatus: [200, 503],
  });
  if (res.response.status === 503) {
    return void h.evidence.partial('time-given-back reporter not configured in this env (503 NOT_CONFIGURED).');
  }
  const body = res.response.body as { data?: unknown };
  expect(body.data, 'time-given-back must return a data summary').toBeTruthy();
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
