import { expect, matrixTest, test, type RowHarness } from './helpers/matrix-test';

/**
 * SET-01 — read + update tenant settings. GET returns the settings object;
 *          PUT updates businessName; a subsequent GET reflects the change.
 */

test.describe.configure({ mode: 'serial' });

matrixTest('SET-01', 'Read + update tenant settings', async (h) => {
  const { token } = h.tenantA;

  await h.api.call({ method: 'GET', path: '/api/settings', token, label: '01-get', expectStatus: 200 });

  const newName = `QA Settings Co ${Date.now()}`;
  await h.api.call({
    method: 'PUT',
    path: '/api/settings',
    body: { businessName: newName },
    token,
    label: '01-update',
    expectStatus: 200,
  });

  const after = await h.api.call({ method: 'GET', path: '/api/settings', token, label: '01-get-after', expectStatus: 200 });
  const body = after.response.body as { businessName?: string; data?: { businessName?: string } };
  const name = body.businessName ?? body.data?.businessName;
  expect(name, 'updated businessName must be reflected on read').toBe(newName);

  await gotoUi(h, '/settings', '01-settings-ui');
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
