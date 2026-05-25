import { expect, matrixTest, test, type RowHarness } from './helpers/matrix-test';

/**
 * JOB-01 — job status lifecycle walked through the REST transition endpoint:
 *          new → scheduled → in_progress → completed, DB-verified each step.
 * JOB-02 — an invalid transition (new → completed) is rejected and leaves the
 *          job untouched (server-side state-machine enforcement).
 *
 * Each row seeds its own customer + location + job, so rows are independent
 * and re-runnable (a completed job is terminal and can't be re-walked).
 */

test.describe.configure({ mode: 'serial' });

async function seedJob(h: RowHarness, label: string): Promise<string> {
  const { token } = h.tenantA;
  const stamp = Date.now();
  const customer = await h.api.call({
    method: 'POST',
    path: '/api/customers',
    body: { firstName: 'Job', lastName: `QA-${label}-${stamp}`, primaryPhone: `+1555${String(stamp).slice(-7)}` },
    token,
    label: `${label}-customer`,
    expectStatus: 201,
  });
  const customerId = (customer.response.body as { id: string }).id;
  const location = await h.api.call({
    method: 'POST',
    path: '/api/locations',
    body: { customerId, street1: '1 Job Way', city: 'Testville', state: 'CA', postalCode: '90001' },
    token,
    label: `${label}-location`,
    expectStatus: 201,
  });
  const locationId = (location.response.body as { id: string }).id;
  const job = await h.api.call({
    method: 'POST',
    path: '/api/jobs',
    body: { customerId, locationId, summary: `QA lifecycle job ${label}`, priority: 'normal' },
    token,
    label: `${label}-job`,
    expectStatus: 201,
  });
  return (job.response.body as { id: string }).id;
}

/**
 * Reads the job status, polling briefly. The transition is committed by the
 * API before its 200, but the verifier reads over a *separate* connection;
 * a short poll absorbs any sub-tick read-after-write window when `want` is set.
 */
async function dbStatus(h: RowHarness, label: string, jobId: string, want?: string): Promise<string> {
  let status = '';
  for (let attempt = 0; attempt < 5; attempt++) {
    const row = await h.db.query({
      label: attempt === 0 ? label : `${label}-retry${attempt}`,
      tenantId: h.tenantA.tenantId,
      sql: `SELECT status FROM jobs WHERE id = $1`,
      params: [jobId],
    });
    expect(row.rowCount, `${label}: job row must exist`).toBe(1);
    status = (row.rows[0] as { status: string }).status;
    if (want === undefined || status === want) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  return status;
}

async function transition(h: RowHarness, jobId: string, status: string, label: string, expectStatus?: number) {
  return h.api.call({
    method: 'POST',
    path: `/api/jobs/${jobId}/transition`,
    body: { status },
    token: h.tenantA.token,
    label,
    ...(expectStatus !== undefined ? { expectStatus } : {}),
  });
}

matrixTest('JOB-01', 'Job status lifecycle (new → scheduled → in_progress → completed)', async (h) => {
  const jobId = await seedJob(h, '01');
  expect(await dbStatus(h, '01-status-new', jobId), 'new job starts in `new`').toBe('new');

  for (const next of ['scheduled', 'in_progress', 'completed'] as const) {
    await transition(h, jobId, next, `01-to-${next}`, 200);
    expect(await dbStatus(h, `01-status-${next}`, jobId, next), `job must persist status=${next}`).toBe(next);
  }

  await gotoUi(h, '/jobs', '01-jobs-ui');
  h.evidence.pass();
});

matrixTest('JOB-02', 'Invalid job transition rejected', async (h) => {
  const jobId = await seedJob(h, '02');
  // new → completed skips scheduled/in_progress and must be refused.
  const res = await transition(h, jobId, 'completed', '02-invalid-jump');
  expect(res.response.status, 'invalid transition must be a 4xx rejection').toBeGreaterThanOrEqual(400);
  expect(res.response.status, 'invalid transition must not be a 5xx').toBeLessThan(500);
  expect(await dbStatus(h, '02-status-after', jobId), 'rejected transition must leave the job in `new`').toBe('new');
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
