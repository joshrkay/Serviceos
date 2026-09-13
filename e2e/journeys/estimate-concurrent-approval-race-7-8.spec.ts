import { APIRequestContext, APIResponse, Page } from '@playwright/test';
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
 * §8.7 row 7.8 — rung-5 reachability: two estimates on ONE job, approved at
 * the same instant through the REAL public route
 * (`POST /public/estimates/:token/approve`), race against real Postgres's
 * partial unique index (see public-estimate-service.ts's 23505 catch).
 * Exactly one settles; the loser gets the SAME mapped `ConflictError`
 * (`/already.*accepted/i`, HTTP 409) whether it lost the pre-check or the
 * DB race itself — never a raw/unmapped 500. Mirrors
 * test/integration/estimate-phases.test.ts's "Phase 3" test (same job, same
 * assertions) one layer up, through the real HTTP route instead of calling
 * the service directly. Both tenants race their OWN job at the SAME
 * instant, so T2 isolation is proven under real concurrency, not just
 * sequentially.
 */

async function createAndSendEstimate(
  request: APIRequestContext,
  tenant: Tenant,
  job: JobRef,
  description: string,
  priceCents: number,
): Promise<{ estimateId: string; viewToken: string }> {
  const estimateRes = await request.post(`${API_URL}/api/estimates`, {
    headers: { 'content-type': 'application/json', ...tenant.authHeaders },
    data: JSON.stringify({
      jobId: job.jobId,
      lineItems: [
        {
          id: randomUUID(),
          description,
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

async function raceApprovals(
  request: APIRequestContext,
  tenant: Tenant,
  job: JobRef,
  label: string,
): Promise<{ winnerEstimateId: string; loserRes: APIResponse }> {
  const estA = await createAndSendEstimate(request, tenant, job, `${label} Repair option A`, 10_000);
  const estB = await createAndSendEstimate(request, tenant, job, `${label} Repair option B`, 12_000);

  const [resA, resB] = await Promise.all([
    request.post(`${API_URL}/public/estimates/${estA.viewToken}/approve`, {
      headers: { 'content-type': 'application/json' },
      data: JSON.stringify({ acceptedByName: `${label} Customer A` }),
    }),
    request.post(`${API_URL}/public/estimates/${estB.viewToken}/approve`, {
      headers: { 'content-type': 'application/json' },
      data: JSON.stringify({ acceptedByName: `${label} Customer B` }),
    }),
  ]);

  const [winner, loser, winnerId] = resA.ok()
    ? [resA, resB, estA.estimateId]
    : [resB, resA, estB.estimateId];

  expect(winner.ok(), `winner should be 200 -> got ${winner.status()}`).toBeTruthy();
  expect(loser.status(), 'loser must be a clean 409 conflict, never a 500').toBe(409);
  const loserBody = (await loser.json()) as { message?: string; error?: string };
  expect(loserBody.error).toBe('CONFLICT');
  expect(loserBody.message ?? '').toMatch(/already.*accepted/i);

  return { winnerEstimateId: winnerId, loserRes: loser };
}

test.describe('concurrent estimate-approval race, exactly one wins (7.8) — real Postgres', () => {
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

  test('two estimates on one job approved at the same instant settle to exactly one accepted, the loser gets a clean 409; T2 on a second, independent tenant racing the same instant', async ({
    request,
    page,
  }: { request: APIRequestContext; page: Page }) => {
    test.setTimeout(150_000);

    // ── Tenant A ─────────────────────────────────────────────────────────
    const tenantA = await bootstrapOwner(request, 'a', 'Acme HVAC 7.8');
    const jobA = await seedJob(request, tenantA, 'RaceOne');

    // ── Tenant B (T2) — an independent tenant racing its OWN job at the
    //    same instant, proving isolation holds under concurrency too ──────
    const tenantB = await bootstrapOwner(request, 'b', 'Bexar Plumbing 7.8');
    const jobB = await seedJob(request, tenantB, 'RaceTwo');

    const [{ winnerEstimateId: winnerA }, { winnerEstimateId: winnerB }] = await Promise.all([
      raceApprovals(request, tenantA, jobA, 'TenantA'),
      raceApprovals(request, tenantB, jobB, 'TenantB'),
    ]);

    // ── Durable read-back, tenant A: exactly one accepted on the job ───────
    const onJobA = await queryAsTenant(
      tenantA.tenantId,
      `SELECT id, status FROM estimates WHERE tenant_id = $1 AND job_id = $2`,
      [tenantA.tenantId, jobA.jobId],
    );
    expect(onJobA.filter((e) => e.status === 'accepted')).toHaveLength(1);
    expect(onJobA.filter((e) => e.status === 'accepted')[0]!.id).toBe(winnerA);

    const approvedAuditA = await queryAsTenant(
      tenantA.tenantId,
      `SELECT event_type FROM audit_events WHERE tenant_id = $1 AND entity_type = 'estimate' AND entity_id = $2 AND event_type = 'public_estimate.approved'`,
      [tenantA.tenantId, winnerA],
    );
    expect(approvedAuditA, 'exactly one approved audit row on the winner').toHaveLength(1);

    // ── Durable read-back, tenant B: same shape, completely independent ────
    const onJobB = await queryAsTenant(
      tenantB.tenantId,
      `SELECT id, status FROM estimates WHERE tenant_id = $1 AND job_id = $2`,
      [tenantB.tenantId, jobB.jobId],
    );
    expect(onJobB.filter((e) => e.status === 'accepted')).toHaveLength(1);
    expect(onJobB.filter((e) => e.status === 'accepted')[0]!.id).toBe(winnerB);

    // Cross-tenant negative: A's winning estimate is invisible under B's scope.
    const crossRead = await request.get(`${API_URL}/api/estimates/${winnerA}`, {
      headers: tenantB.authHeaders,
    });
    expect([403, 404]).toContain(crossRead.status());

    // ── Visual evidence: the winning estimate's durable public view ────────
    const onJobDetail = await request.get(`${API_URL}/api/estimates?jobId=${jobA.jobId}`, {
      headers: tenantA.authHeaders,
    });
    const list = (await onJobDetail.json()) as Array<{ id: string; viewToken?: string }>;
    const winnerRow = list.find((e) => e.id === winnerA);
    expect(winnerRow?.viewToken, 'the winning estimate must carry a view token').toBeTruthy();
    await page.goto(`/e/${winnerRow!.viewToken}`);
    await expect(page.getByRole('heading', { name: /Estimate accepted!/i })).toBeVisible({
      timeout: 15_000,
    });
    await page.screenshot({ path: join(SCREENSHOT_DIR, '7.8-winner-accepted-public-view.png') });
  });
});
