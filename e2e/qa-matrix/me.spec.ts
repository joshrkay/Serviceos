import { expect, matrixTest, test } from './helpers/matrix-test';

/**
 * ME-01 — the authenticated-user endpoint and the field-serve mode switch.
 * GET /api/me echoes the caller's identity; POST /api/me/mode validates the
 * target mode and (for an owner) switches it, emitting a mode_switched audit
 * event. We assert the endpoint contract + the audit side effect rather than
 * the persisted users.current_mode, because the QA fixture mints a token
 * without a backing users row, so the mode UPDATE is a deliberate no-op.
 */

test.describe.configure({ mode: 'serial' });

matrixTest('ME-01', 'Current-user profile + mode switch', async (h) => {
  const { token, tenantId } = h.tenantA;

  const me = await h.api.call({
    method: 'GET',
    path: '/api/me',
    token,
    label: '01-get-me',
    expectStatus: 200,
  });
  const body = me.response.body as { user_id: string; tenant_id: string; role: string; current_mode: string };
  expect(body.user_id, 'identity must echo the token subject').toBe('qa-matrix-user-A');
  expect(body.tenant_id, 'identity must echo the tenant').toBe(tenantId);
  expect(body.role, 'owner token must report owner role').toBe('owner');
  expect(['supervisor', 'tech', 'both']).toContain(body.current_mode);

  await h.api.call({
    method: 'POST',
    path: '/api/me/mode',
    body: { mode: 'not-a-mode' },
    token,
    label: '01-invalid-mode',
    expectStatus: 400,
  });

  await h.api.call({
    method: 'POST',
    path: '/api/me/mode',
    body: { mode: 'both' },
    token,
    label: '01-switch-mode',
    expectStatus: 204,
  });

  const audit = await h.db.query({
    label: '01-mode-audit',
    tenantId,
    sql: `SELECT event_type FROM audit_events WHERE tenant_id = $1 AND entity_id = $2 AND event_type = 'mode_switched'`,
    params: [tenantId, 'qa-matrix-user-A'],
  });
  expect(audit.rowCount, 'a valid mode switch must emit a mode_switched audit event').toBeGreaterThanOrEqual(1);

  h.evidence.pass();
});
