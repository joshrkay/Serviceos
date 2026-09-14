import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { installClerkStub } from '../helpers/clerk-stub';
import { hasViteClerkKey } from '../helpers/clerk-key';
import {
  API_URL,
  bootstrapOwner,
  seedCustomerJob,
  queryAsTenant,
  pollUntilOk,
  Tenant,
} from '../fixtures/money-lane-8-8';

/**
 * 8.3 — rung-5 reachability: "a completed job offers me an invoice, so
 * nothing ages unbilled". `update-job-execution.test.ts` already proves
 * `completed_at` stamping at real Postgres (T1). PR #1053's
 * `revenue-cluster-toggles.spec.ts` already proves the owner can flip
 * `autoInvoiceOnCompletion` through Settings in a real browser. What's new
 * here: the FULL loop — toggle -> accept an estimate -> complete the job
 * through the real `POST /api/jobs/:id/transition` route -> the
 * `draft_invoice` proposal `maybeAutoInvoiceOnCompletion`
 * (invoices/auto-invoice-on-completion.ts:55) actually drafts, read back
 * on the owner's real Inbox screen — with a SECOND tenant left on the
 * default (false) setting proving BOTH T2 (isolation) and T3 (the same
 * code path takes a different per-tenant config down a different branch).
 */

const SCREENSHOT_DIR = join(process.cwd(), 'docs/audit/lane-reports/8-8-bill-r5');
mkdirSync(SCREENSHOT_DIR, { recursive: true });

test.describe('job completion auto-drafts an invoice proposal (8.3) — real Postgres', () => {
  const canRun =
    !process.env.E2E_BASE_URL &&
    hasViteClerkKey() &&
    process.env.E2E_USE_TEST_DB === 'true';
  test.skip(
    !canRun,
    'Requires the local webServer pair against a real Postgres: leave E2E_BASE_URL unset, ' +
      'set VITE_CLERK_PUBLISHABLE_KEY (placeholder ok), and E2E_USE_TEST_DB=true with ' +
      'DATABASE_URL pointing at the test container.',
  );

  async function createAcceptedEstimate(
    request: import('@playwright/test').APIRequestContext,
    tenant: Tenant,
    jobId: string,
    totalCents: number,
  ): Promise<string> {
    const estRes = await request.post(`${API_URL}/api/estimates`, {
      headers: { 'content-type': 'application/json', ...tenant.authHeaders },
      data: JSON.stringify({
        jobId,
        lineItems: [
          {
            id: randomUUID(),
            description: 'Completed diagnostic + repair',
            quantity: 1,
            unitPriceCents: totalCents,
            totalCents,
            sortOrder: 0,
            taxable: false,
          },
        ],
      }),
    });
    expect(estRes.ok(), `create estimate -> ${estRes.status()} ${await estRes.text()}`).toBeTruthy();
    const estimate = (await estRes.json()) as { id: string };

    const sentRes = await request.post(`${API_URL}/api/estimates/${estimate.id}/transition`, {
      headers: { 'content-type': 'application/json', ...tenant.authHeaders },
      data: JSON.stringify({ status: 'sent' }),
    });
    expect(sentRes.ok(), `sent -> ${sentRes.status()} ${await sentRes.text()}`).toBeTruthy();

    const acceptedRes = await request.post(`${API_URL}/api/estimates/${estimate.id}/transition`, {
      headers: { 'content-type': 'application/json', ...tenant.authHeaders },
      data: JSON.stringify({ status: 'accepted' }),
    });
    expect(acceptedRes.ok(), `accepted -> ${acceptedRes.status()} ${await acceptedRes.text()}`).toBeTruthy();

    return estimate.id;
  }

  /** JOB_STATUS_TRANSITIONS (job-lifecycle.ts:51): new -> scheduled -> in_progress -> completed. */
  async function completeJob(
    request: import('@playwright/test').APIRequestContext,
    tenant: Tenant,
    jobId: string,
  ) {
    for (const status of ['scheduled', 'in_progress', 'completed']) {
      const res = await request.post(`${API_URL}/api/jobs/${jobId}/transition`, {
        headers: { 'content-type': 'application/json', ...tenant.authHeaders },
        data: JSON.stringify({ status }),
      });
      expect(res.ok(), `transition -> ${status} -> ${res.status()} ${await res.text()}`).toBeTruthy();
      if (status === 'completed') return res;
    }
    throw new Error('unreachable');
  }

  test('an owner enables auto-invoice, accepts an estimate, and completing the job through the real route auto-drafts a proposal visible on the real Inbox; a neighbour left on the default setting gets none', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);

    // ── Tenant A: opts IN (T3 — a tenant-specific config value) ──────────
    const tenantA = await bootstrapOwner(request, 'a', 'Auto-Invoice HVAC 8.3');
    const enableRes = await request.put(`${API_URL}/api/settings`, {
      headers: { 'content-type': 'application/json', ...tenantA.authHeaders },
      data: JSON.stringify({ autoInvoiceOnCompletion: true }),
    });
    expect(enableRes.ok(), `PUT settings (A) -> ${enableRes.status()}`).toBeTruthy();

    const seedA = await seedCustomerJob(request, tenantA, 'Sasha', '8.3 auto-invoice journey');
    await createAcceptedEstimate(request, tenantA, seedA.jobId, 27_500);

    const completeA = await completeJob(request, tenantA, seedA.jobId);
    const completedJobA = (await completeA.json()) as { job: { status: string; completedAt?: string } };
    expect(completedJobA.job.status).toBe('completed');
    expect(completedJobA.job.completedAt).toBeTruthy();

    // ── Tenant B: left on the DEFAULT (false) — same code path, no draft ──
    const tenantB = await bootstrapOwner(request, 'b', 'Default Plumbing 8.3');
    const settingsB = await request.get(`${API_URL}/api/settings`, { headers: tenantB.authHeaders });
    expect(((await settingsB.json()) as { autoInvoiceOnCompletion?: boolean }).autoInvoiceOnCompletion ?? false).toBe(false);

    const seedB = await seedCustomerJob(request, tenantB, 'Rowan', '8.3 neighbour journey');
    await createAcceptedEstimate(request, tenantB, seedB.jobId, 9_900);
    const completeB = await completeJob(request, tenantB, seedB.jobId);
    const completedJobB = (await completeB.json()) as { job: { status: string; completedAt?: string } };
    expect(completedJobB.job.status).toBe('completed');
    expect(completedJobB.job.completedAt).toBeTruthy();

    // ── Durable proof, both tenants ────────────────────────────────────────
    await pollUntilOk(request, `${API_URL}/api/jobs/${seedA.jobId}`, tenantA.authHeaders);
    const proposalsA = await queryAsTenant(
      tenantA.tenantId,
      `SELECT id, proposal_type, status, summary, payload FROM proposals WHERE tenant_id = $1 AND proposal_type = 'draft_invoice'`,
      [tenantA.tenantId],
    );
    expect(proposalsA, 'tenant A (opted in) gets exactly one auto-drafted invoice proposal').toHaveLength(1);
    expect(proposalsA[0].summary).toBe('Draft invoice for completed job');
    expect((proposalsA[0].payload as { jobId?: string }).jobId).toBe(seedA.jobId);

    const proposalsB = await queryAsTenant(
      tenantB.tenantId,
      `SELECT id FROM proposals WHERE tenant_id = $1 AND proposal_type = 'draft_invoice'`,
      [tenantB.tenantId],
    );
    expect(proposalsB, 'tenant B (default setting) gets none — same code path, config gate closed').toHaveLength(0);

    // T2 — tenant B's RLS session cannot see tenant A's proposal either.
    const crossRead = await queryAsTenant(
      tenantB.tenantId,
      `SELECT id FROM proposals WHERE tenant_id = $1 AND id = $2`,
      [tenantB.tenantId, proposalsA[0].id as string],
    );
    expect(crossRead).toHaveLength(0);

    // ── The owner's real Inbox screen shows it ────────────────────────────
    await installClerkStub(page, { signedIn: true, sub: tenantA.ownerSub, token: tenantA.jwt });
    await page.goto('/inbox');
    await expect(page.getByText('Draft invoice for completed job').first()).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: join(SCREENSHOT_DIR, '8.3-inbox-auto-invoice.png') });
  });
});
