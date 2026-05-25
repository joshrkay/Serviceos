import { expect, matrixTest, test } from './helpers/matrix-test';

/**
 * FLAG-01 — the feature-flag admin surface (/api/admin/feature-flags) is
 * platform-admin gated. A normal tenant owner must be refused on both read
 * and write (the platform-admin check fails → 403/503), proving the gate
 * blocks tenant-level callers from toggling platform flags.
 */

test.describe.configure({ mode: 'serial' });

const DENIED = [401, 403, 503];

matrixTest('FLAG-01', 'Feature-flag admin is platform-admin gated', async (h) => {
  const { token } = h.tenantA;

  const list = await h.api.call({
    method: 'GET',
    path: '/api/admin/feature-flags',
    token,
    label: '01-list-denied',
  });
  expect(DENIED, `owner GET on admin flags must be denied, got ${list.response.status}`).toContain(list.response.status);

  const put = await h.api.call({
    method: 'PUT',
    path: `/api/admin/feature-flags/qa_flag_${Date.now()}`,
    body: { enabled: true },
    token,
    label: '01-write-denied',
  });
  expect(DENIED, `owner PUT on admin flags must be denied, got ${put.response.status}`).toContain(put.response.status);

  h.evidence.pass();
});
