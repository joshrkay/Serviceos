import { Page, APIRequestContext } from '@playwright/test';
import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { hasViteClerkKey } from '../helpers/clerk-key';
import {
  API_URL,
  bootstrapOwner,
  seedJob,
  queryAsTenant,
  type Tenant,
  type JobRef,
} from '../fixtures/estimate-quote-lane';

const SCREENSHOT_DIR = join(process.cwd(), 'docs/audit/lane-reports/8-7-quote-r5');
mkdirSync(SCREENSHOT_DIR, { recursive: true });

/**
 * §8.7 row 7.7 — rung-5 reachability: a customer holding a stale version of
 * an estimate is refused, the row stays `sent`; the SAME customer, on the
 * current version, is accepted. Real surface: the public token page
 * (`/e/:token`) exactly as row 7.6 exercises it, isolated here to 7.7's own
 * acceptance so its pass/fail is legible on its own (7.6's spec already
 * covers this as a secondary leg; this file is the dedicated, first-class
 * proof, with its own audit read-back: exactly one `estimate.revised` event,
 * and NO `public_estimate.approved` alongside the refused attempt), run
 * end-to-end twice — once per tenant — so T1 isolation holds under the SAME
 * scenario, not just a lighter touch check.
 */

async function createAndSendEstimate(
  request: APIRequestContext,
  tenant: Tenant,
  job: JobRef,
  priceCents: number,
): Promise<{ estimateId: string; viewToken: string }> {
  const estimateRes = await request.post(`${API_URL}/api/estimates`, {
    headers: { 'content-type': 'application/json', ...tenant.authHeaders },
    data: JSON.stringify({
      jobId: job.jobId,
      lineItems: [
        {
          id: randomUUID(),
          description: 'Diagnostic visit',
          quantity: 1,
          unitPriceCents: priceCents,
          totalCents: priceCents,
          sortOrder: 0,
          taxable: false,
        },
      ],
    }),
  });
  expect(estimateRes.ok(), `create estimate -> ${estimateRes.status()}`).toBeTruthy();
  const estimate = (await estimateRes.json()) as { id: string };

  const sendRes = await request.post(`${API_URL}/api/estimates/${estimate.id}/send`, {
    headers: { 'content-type': 'application/json', ...tenant.authHeaders },
    data: JSON.stringify({ channel: 'email' }),
  });
  expect(sendRes.ok(), `send -> ${sendRes.status()}`).toBeTruthy();
  const sent = (await sendRes.json()) as { viewToken: string };
  return { estimateId: estimate.id, viewToken: sent.viewToken };
}

async function acceptViaPublicPage(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: /Accept this estimate/i }).click();
  await page.getByPlaceholder('Your full name').fill(name);
  await page.getByRole('button', { name: /^Accept estimate$/ }).click();
}

test.describe('stale-version approve is refused; current version is accepted (7.7) — real Postgres', () => {
  const canRun =
    !process.env.E2E_BASE_URL &&
    hasViteClerkKey() &&
    process.env.E2E_USE_TEST_DB === 'true';
  test.skip(
    !canRun,
    'Requires the local webServer pair against a real Postgres: leave E2E_BASE_URL unset, ' +
      'set VITE_CLERK_PUBLISHABLE_KEY (placeholder ok), and E2E_USE_TEST_DB=true with DATABASE_URL ' +
      'pointing at the test container.',
  );
  test.use({ viewport: { width: 390, height: 844 } });

  test('a revision mid-session refuses the stale approve (409/banner, status stays sent); the current version then accepts; T1 isolation on a second tenant running the same scenario', async ({
    page,
    request,
  }) => {
    test.setTimeout(150_000);
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    async function runScenario(label: string, businessName: string) {
      const tenant = await bootstrapOwner(request, label, businessName);
      const job = await seedJob(request, tenant, 'StaleGuard');
      const target = await createAndSendEstimate(request, tenant, job, 12_000);

      // Customer opens the link — the browser now holds the PRE-revision
      // version in React state.
      await page.goto(`/e/${target.viewToken}`);
      await expect(page.getByText(businessName, { exact: true })).toBeVisible();
      await page.screenshot({ path: join(SCREENSHOT_DIR, `7.7-${label}-before-revise.png`) });

      // The business revises the estimate WHILE the customer's page is open.
      const reviseRes = await request.post(`${API_URL}/api/estimates/${target.estimateId}/revise`, {
        headers: { 'content-type': 'application/json', ...tenant.authHeaders },
        data: JSON.stringify({ customerMessage: `Scope updated for ${label}.` }),
      });
      expect(reviseRes.ok(), `revise -> ${reviseRes.status()} ${await reviseRes.text()}`).toBeTruthy();

      await acceptViaPublicPage(page, `Stale Customer ${label}`);

      // Refused — bounced back to the page with the revised banner, never
      // the success screen; the row stays `sent`.
      await expect(page.getByText(/This estimate was updated by the business/i)).toBeVisible({
        timeout: 10_000,
      });
      await expect(page.getByRole('heading', { name: /Estimate accepted!/i })).toHaveCount(0);
      await page.screenshot({ path: join(SCREENSHOT_DIR, `7.7-${label}-stale-refused.png`) });

      const staleRow = await request.get(`${API_URL}/api/estimates/${target.estimateId}`, {
        headers: tenant.authHeaders,
      });
      const staleEstimate = (await staleRow.json()) as { status: string; acceptedAt?: string };
      expect(staleEstimate.status).toBe('sent');
      expect(staleEstimate.acceptedAt).toBeUndefined();

      // Exactly one estimate.revised audit row; NO public_estimate.approved
      // audit row leaked in alongside the refused attempt.
      const revisedAudit = await queryAsTenant(
        tenant.tenantId,
        `SELECT event_type FROM audit_events WHERE tenant_id = $1 AND entity_type = 'estimate' AND entity_id = $2 AND event_type = 'estimate.revised'`,
        [tenant.tenantId, target.estimateId],
      );
      expect(revisedAudit).toHaveLength(1);
      const phantomApproved = await queryAsTenant(
        tenant.tenantId,
        `SELECT event_type FROM audit_events WHERE tenant_id = $1 AND entity_type = 'estimate' AND entity_id = $2 AND event_type = 'public_estimate.approved'`,
        [tenant.tenantId, target.estimateId],
      );
      expect(phantomApproved, 'a refused stale accept must never leave an approved audit row').toHaveLength(0);

      // Reload — the customer now sees the current version and CAN accept.
      await page.reload({ waitUntil: 'domcontentloaded' });
      await acceptViaPublicPage(page, `Current Customer ${label}`);
      await expect(page.getByRole('heading', { name: /Estimate accepted!/i })).toBeVisible({ timeout: 15_000 });
      await page.screenshot({ path: join(SCREENSHOT_DIR, `7.7-${label}-current-accepted.png`) });

      const acceptedRow = await request.get(`${API_URL}/api/estimates/${target.estimateId}`, {
        headers: tenant.authHeaders,
      });
      const acceptedEstimate = (await acceptedRow.json()) as { status: string };
      expect(acceptedEstimate.status).toBe('accepted');

      const approvedAudit = await queryAsTenant(
        tenant.tenantId,
        `SELECT event_type FROM audit_events WHERE tenant_id = $1 AND entity_type = 'estimate' AND entity_id = $2 AND event_type = 'public_estimate.approved'`,
        [tenant.tenantId, target.estimateId],
      );
      expect(approvedAudit).toHaveLength(1);

      return { tenant, target };
    }

    // ── Tenant A ─────────────────────────────────────────────────────────
    const { tenant: tenantA, target: targetA } = await runScenario('a', 'Acme HVAC 7.7');

    // ── Tenant B (T1) — the SAME scenario, wholly independent ──────────────
    const { tenant: tenantB, target: targetB } = await runScenario('b', 'Bexar Plumbing 7.7');

    // Cross-tenant negative both ways.
    const crossAB = await request.get(`${API_URL}/api/estimates/${targetB.estimateId}`, {
      headers: tenantA.authHeaders,
    });
    expect([403, 404]).toContain(crossAB.status());
    const crossBA = await request.get(`${API_URL}/api/estimates/${targetA.estimateId}`, {
      headers: tenantB.authHeaders,
    });
    expect([403, 404]).toContain(crossBA.status());

    expect(pageErrors, 'no uncaught page errors during the stale-revision journey').toEqual([]);
  });
});
