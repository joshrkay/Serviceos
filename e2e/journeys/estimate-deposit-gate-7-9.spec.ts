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
  stripeSignature,
  logRows,
  drawSignature,
  type Tenant,
  type JobRef,
} from '../fixtures/estimate-quote-lane';

const SCREENSHOT_DIR = join(process.cwd(), 'docs/audit/lane-reports/8-7-quote-r5');
mkdirSync(SCREENSHOT_DIR, { recursive: true });

/**
 * §8.7 row 7.9 — rung-5 reachability: `before_approval` blocks acceptance
 * until the deposit is paid, and the fixed-amount rule caps the required
 * deposit at the estimate total, never above it. Deposit rules are set
 * through the REAL owner-authenticated `PUT /api/settings` route
 * (shared/contracts.ts `updateSettingsSchema`'s `depositStrategy` /
 * `depositFixedCents` / `depositPercentageBps` / `depositTimingPolicy`
 * fields — the same route `DepositRulesSheet.tsx` calls) — this doubles as
 * the T3 leg (tenant A: fixed + before_approval; tenant B: percentage +
 * after_approval — divergent per-tenant CONFIG on the same code path).
 *
 * NOT proven here (pinned, not faked — see the second test below): actually
 * PAYING a `before_approval` deposit and then approving.
 * `PublicEstimateService.getOrCreateDepositCheckoutUrl`
 * (packages/api/src/estimates/public-estimate-service.ts:756-758) throws
 * `ValidationError('Payment processing is not configured')` whenever
 * `stripeConfig.apiKey` is unset, with NO Mock-provider fallback — unlike
 * the invoice payment-link path (`createPaymentLinkProvider`, which falls
 * back to `MockPaymentLinkProvider` regardless of a real key, per
 * e2e/journeys/public-invoice-pay-link.spec.ts's own header comment). That
 * asymmetry means `depositRequiredCents` can never be written onto the job
 * for a `before_approval` tenant without a REAL Stripe key in this sandbox —
 * the signed-webhook-settlement technique row 8.4 uses can't help here
 * because the deposit webhook branch itself refuses to credit when
 * `job.depositRequiredCents` is still 0
 * (packages/api/src/webhooks/routes.ts:1409-1414, "Deposit paid for job with
 * no required deposit"). Parked with the existing #1000/#1002 (live
 * Stripe/device) decision — Fable files the ticket if a narrower gap is
 * wanted. `after_approval` (tenant B, T3) has no such chicken-and-egg
 * problem (the required amount is written automatically on a successful
 * accept) and IS settled end-to-end below, using row 8.4's exact signed-
 * webhook technique.
 */

async function setDepositRule(
  request: APIRequestContext,
  tenant: Tenant,
  body: Record<string, unknown>,
): Promise<void> {
  const res = await request.put(`${API_URL}/api/settings`, {
    headers: { 'content-type': 'application/json', ...tenant.authHeaders },
    data: JSON.stringify(body),
  });
  expect(res.ok(), `PUT /api/settings -> ${res.status()} ${await res.text()}`).toBeTruthy();
}

async function createAndSendEstimate(
  request: APIRequestContext,
  tenant: Tenant,
  job: JobRef,
  totalCents: number,
): Promise<{ estimateId: string; viewToken: string }> {
  const estimateRes = await request.post(`${API_URL}/api/estimates`, {
    headers: { 'content-type': 'application/json', ...tenant.authHeaders },
    data: JSON.stringify({
      jobId: job.jobId,
      lineItems: [
        {
          id: randomUUID(),
          description: 'Deposit-gated repair',
          quantity: 1,
          unitPriceCents: totalCents,
          totalCents,
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

test.describe('deposit-before-approval gate + fixed-amount cap (7.9) — real Postgres', () => {
  const canRun =
    !process.env.E2E_BASE_URL &&
    hasViteClerkKey() &&
    process.env.E2E_USE_TEST_DB === 'true' &&
    !!process.env.STRIPE_WEBHOOK_SECRET;
  test.skip(
    !canRun,
    'Requires the local webServer pair against a real Postgres, plus STRIPE_WEBHOOK_SECRET ' +
      '(set before `npx playwright test` starts) for the after_approval settlement leg.',
  );
  test.use({ viewport: { width: 390, height: 844 } });

  test('before_approval blocks Approve and shows the CAPPED deposit; after_approval (T3, divergent config) accepts immediately and settles via a signed webhook', async ({
    page,
    request,
  }) => {
    test.setTimeout(150_000);
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    // ── Tenant A — fixed $200 deposit, capped at the $99 estimate total,
    //    before_approval ─────────────────────────────────────────────────
    const tenantA = await bootstrapOwner(request, 'a', 'Acme HVAC 7.9');
    await setDepositRule(request, tenantA, {
      depositStrategy: 'fixed',
      depositFixedCents: 20_000,
      depositTimingPolicy: 'before_approval',
    });
    const jobA = await seedJob(request, tenantA, 'DepositGate');
    const targetA = await createAndSendEstimate(request, tenantA, jobA, 9_900);

    // ── Tenant B (T3) — 10% deposit, after_approval, wholly different
    //    config on the SAME code path ────────────────────────────────────
    const tenantB = await bootstrapOwner(request, 'b', 'Bexar Plumbing 7.9');
    await setDepositRule(request, tenantB, {
      depositStrategy: 'percentage',
      depositPercentageBps: 1_000,
      depositTimingPolicy: 'after_approval',
    });
    const jobB = await seedJob(request, tenantB, 'DepositLater');
    const targetB = await createAndSendEstimate(request, tenantB, jobB, 50_000);

    // ── Tenant A: the real public page shows the Pay-deposit CTA in place
    //    of Approve, with the CAPPED amount ($99.00, not $200.00) ──────────
    await page.goto(`/e/${targetA.viewToken}`);
    await expect(page.getByText('Acme HVAC 7.9', { exact: true })).toBeVisible();
    const notice = page.getByTestId('estimate-deposit-notice');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('$99.00');
    await expect(page.getByText('$200.00')).toHaveCount(0);
    await expect(page.getByTestId('estimate-pay-deposit-cta')).toBeVisible();
    await expect(page.getByRole('button', { name: /^Accept this estimate$/ })).toHaveCount(0);
    await page.screenshot({ path: join(SCREENSHOT_DIR, '7.9-before-approval-gate.png') });

    // Real API attempt to approve without paying — a clean 409, matching
    // the mapped ConflictError, never a 500.
    const blockedApprove = await request.post(`${API_URL}/public/estimates/${targetA.viewToken}/approve`, {
      headers: { 'content-type': 'application/json' },
      data: JSON.stringify({ acceptedByName: 'Deposit Skipper' }),
    });
    logRows(`7.9 tenant A approve-without-deposit response (${blockedApprove.status()})`, await blockedApprove.json());
    expect(blockedApprove.status()).toBe(409);
    const blockedBody = (await blockedApprove.json()) as { message?: string };
    expect(blockedBody.message ?? '').toMatch(/deposit must be paid/i);

    const stillSent = await request.get(`${API_URL}/api/estimates/${targetA.estimateId}`, {
      headers: tenantA.authHeaders,
    });
    expect(((await stillSent.json()) as { status: string }).status).toBe('sent');

    // ── Tenant B (T3): after_approval — Approve is available immediately,
    //    no deposit obstacle at all under this config ───────────────────────
    await page.goto(`/e/${targetB.viewToken}`);
    await expect(page.getByText('Bexar Plumbing 7.9', { exact: true })).toBeVisible();
    await expect(page.getByTestId('estimate-pay-deposit-cta')).toHaveCount(0);
    await page.getByRole('button', { name: /Accept this estimate/i }).click();
    await page.getByPlaceholder('Your full name').fill('Deferred Deposit Customer');
    // The submit button stays disabled until a signature is drawn (matches
    // e2e/journeys/public-estimate-approve-sign.spec.ts's 7.6 flow).
    await drawSignature(page);
    const submitDeposit = page.getByRole('button', { name: /^Accept estimate$/ });
    await expect(submitDeposit).toBeEnabled();
    await submitDeposit.click();
    await expect(page.getByRole('heading', { name: /Estimate accepted!/i })).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: join(SCREENSHOT_DIR, '7.9-after-approval-accepted-tenantB.png') });
    // after_approval: the success screen now prompts for the (10% of $500)
    // deposit — `depositPayable` flipped true on accept (SuccessScreen,
    // EstimateApprovalPage.tsx `success-deposit-prompt`).
    await expect(page.getByTestId('success-deposit-prompt')).toContainText(/\$50\.00 deposit/, {
      timeout: 10_000,
    });

    // Deposit is now LOCKED onto the job (10% of $500 = $50), unpaid.
    const jobBRow1 = await queryAsTenant(
      tenantB.tenantId,
      `SELECT deposit_required_cents, deposit_paid_cents, deposit_status FROM jobs WHERE id = $1`,
      [jobB.jobId],
    );
    logRows('7.9 tenant B jobs row after after_approval accept', jobBRow1);
    expect(Number(jobBRow1[0]!.deposit_required_cents)).toBe(5_000);
    expect(jobBRow1[0]!.deposit_status).toBe('pending');

    // ── Settle tenant B's deposit exactly like row 8.4 settles an invoice:
    //    a SIGNED checkout.session.completed webhook, metadata carrying
    //    deposit_for_job_id instead of invoice_id ────────────────────────────
    const eventId = `evt_${randomUUID()}`;
    const webhookBody = JSON.stringify({
      id: eventId,
      type: 'checkout.session.completed',
      data: {
        object: {
          metadata: { tenant_id: tenantB.tenantId, deposit_for_job_id: jobB.jobId },
          amount_total: 5_000,
          payment_status: 'paid',
          payment_intent: `pi_${eventId}`,
        },
      },
    });
    const webhookRes = await request.post(`${API_URL}/webhooks/stripe`, {
      headers: {
        'content-type': 'application/json',
        'stripe-signature': stripeSignature(webhookBody, process.env.STRIPE_WEBHOOK_SECRET!),
      },
      data: webhookBody,
    });
    expect(webhookRes.ok(), `webhooks/stripe -> ${webhookRes.status()} ${await webhookRes.text()}`).toBeTruthy();
    expect(await webhookRes.json()).toEqual({ received: true, deposit: true });

    const jobBRow2 = await queryAsTenant(
      tenantB.tenantId,
      `SELECT deposit_required_cents, deposit_paid_cents, deposit_status FROM jobs WHERE id = $1`,
      [jobB.jobId],
    );
    logRows('7.9 tenant B jobs row after signed checkout.session.completed', jobBRow2);
    expect(Number(jobBRow2[0]!.deposit_paid_cents)).toBe(5_000);
    expect(jobBRow2[0]!.deposit_status).toBe('paid');

    // Reload the public page — the durable "Paid" state, not optimistic. An
    // ACCEPTED estimate renders the SuccessScreen, whose paid marker is
    // `success-deposit-paid` (the pre-accept page's `estimate-deposit-notice`
    // is not on this screen — run 1 waited on the wrong testid).
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('success-deposit-paid')).toContainText(/Deposit paid/i, { timeout: 10_000 });
    await expect(page.getByTestId('success-deposit-prompt')).toHaveCount(0);
    await page.screenshot({ path: join(SCREENSHOT_DIR, '7.9-deposit-paid-tenantB.png') });

    // ── Tenant A is completely untouched by tenant B's settlement ──────────
    const jobARow = await queryAsTenant(
      tenantA.tenantId,
      `SELECT deposit_paid_cents FROM jobs WHERE id = $1`,
      [jobA.jobId],
    );
    logRows('7.9 tenant A jobs row untouched by B settlement', jobARow);
    expect(Number(jobARow[0]?.deposit_paid_cents ?? 0)).toBe(0);

    expect(pageErrors, 'no uncaught page errors during the deposit-gate journey').toEqual([]);
  });

  // ── Honest gap: paying a `before_approval` deposit in this sandbox ────────
  test('the real deposit-checkout route genuinely refuses (no live Stripe key, no mock fallback) — pinned, not faked', async ({
    request,
  }) => {
    test.setTimeout(60_000);
    const tenantA = await bootstrapOwner(request, 'pin', 'Acme HVAC 7.9 Pin');
    await setDepositRule(request, tenantA, {
      depositStrategy: 'fixed',
      depositFixedCents: 20_000,
      depositTimingPolicy: 'before_approval',
    });
    const jobA = await seedJob(request, tenantA, 'DepositPin');
    const target = await createAndSendEstimate(request, tenantA, jobA, 9_900);

    test.fail(
      true,
      'packages/api/src/estimates/public-estimate-service.ts (getOrCreateDepositCheckoutUrl): ' +
        "with NO STRIPE_SECRET_KEY it throws ValidationError('Payment processing is not configured') " +
        '(:756-758, → 400) — no Mock-provider fallback, unlike the invoice pay-link path; with the ' +
        'hermetic placeholder key the preamble mandates for money rows it POSTs to the REAL ' +
        'https://api.stripe.com/v1/payment_links (:872-882), Stripe rejects the key, and the plain ' +
        "`throw new Error(`Stripe API error (${res.status})`)` (:883-886) is unmapped → a raw 500 to the " +
        'customer\'s "Pay deposit" tap. Either way job.depositRequiredCents is only persisted AFTER a ' +
        'successful mint (:906-913), so it stays 0, the deposit webhook refuses to credit ' +
        '(webhooks/routes.ts:1409-1414) and approve stays 409. Parked with #1000/#1002 (live Stripe); ' +
        'the unmapped 500 is a separate finding for Fable.',
    );

    // The REAL route a "Pay deposit" tap calls — the actual seam, not a
    // description of it. Observed here: 500 (placeholder key → real Stripe
    // call rejected → unmapped Error). Expected once a real key / mapped
    // error exists: 200 with a url (or a clean 4xx). Both current outcomes
    // are recorded in the run log.
    const checkoutRes = await request.post(
      `${API_URL}/public/estimates/${target.viewToken}/deposit-checkout`,
    );
    const checkoutBody = await checkoutRes.text();
    logRows(`7.9 pin — POST /deposit-checkout (before_approval) response ${checkoutRes.status()}`, checkoutBody);
    const jobRow = await queryAsTenant(
      tenantA.tenantId,
      `SELECT deposit_required_cents, deposit_paid_cents, deposit_status, deposit_stripe_payment_link_url FROM jobs WHERE id = $1`,
      [jobA.jobId],
    );
    logRows('7.9 pin — jobs row after the failed mint (required stays 0 → webhook cannot credit)', jobRow);
    expect(
      [400, 500],
      `deposit-checkout must mint a link (200) — got ${checkoutRes.status()}: ${checkoutBody}`,
    ).not.toContain(checkoutRes.status());
  });
});
