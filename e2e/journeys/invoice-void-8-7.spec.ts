import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { installClerkStub } from '../helpers/clerk-stub';
import { hasViteClerkKey } from '../helpers/clerk-key';
import {
  API_URL,
  bootstrapOwner,
  seedCustomerJob,
  seedIssuedInvoice,
  queryAsTenant,
  pollUntilOk,
} from '../fixtures/money-lane-8-8';

/**
 * 8.7 — rung-5 reachability: "voiding an invoice kills its payment link
 * immediately". PR #1055's `integration/invoice-void-payment-link.test.ts`
 * already proves this at real Postgres through the production
 * `transitionInvoiceStatus` function — called DIRECTLY, in-process, never
 * through an authenticated HTTP request. This spec drives the SAME
 * capability through the real surface an owner actually uses: the owner's
 * browser session issues a payment link (POST /api/invoices/:id/payment-link)
 * then voids the invoice (POST /api/invoices/:id/transition) through the
 * real running API — auth, RLS and route wiring included — and the owner's
 * Invoices screen is the durable proof, not a re-fetch this test invents.
 *
 * The Stripe-side deactivation call itself still lands on the in-repo
 * MockPaymentLinkProvider (no STRIPE_SECRET_KEY set here) — a real-Stripe
 * assertion needs a test-mode key (#1000), unchanged from PR #1055's own
 * honest caveat. What's NEW here: reachability through the real HTTP
 * surface + a second tenant (T2) whose own live link survives untouched,
 * including a cross-tenant void attempt refused by the real route.
 *
 * Bootstrap pattern mirrors e2e/journeys/public-invoice-pay-link.spec.ts.
 */

const SCREENSHOT_DIR = join(process.cwd(), 'docs/audit/lane-reports/8-8-bill-r5');
mkdirSync(SCREENSHOT_DIR, { recursive: true });

test.describe('void kills the payment link immediately (8.7) — real Postgres', () => {
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

  test('an owner voids an invoice through the real API; its link is dead on reload; a neighbour tenant is untouched', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    // ── Tenant A: the invoice under test ────────────────────────────────
    const tenantA = await bootstrapOwner(request, 'a', 'Voidable HVAC 8.7');
    const seedA = await seedCustomerJob(request, tenantA, 'Riley', '8.7 void journey');
    const invoiceA = await seedIssuedInvoice(request, tenantA, seedA.jobId, 42_000);
    await pollUntilOk(
      request,
      `${API_URL}/api/invoices/${invoiceA.invoiceId}`,
      tenantA.authHeaders,
    ); // #1133 workaround

    // ── Tenant B: an independent invoice with its OWN live link ─────────
    const tenantB = await bootstrapOwner(request, 'b', 'Untouched Plumbing 8.7');
    const seedB = await seedCustomerJob(request, tenantB, 'Sam', '8.7 neighbour journey');
    const invoiceB = await seedIssuedInvoice(request, tenantB, seedB.jobId, 9_900);
    await pollUntilOk(
      request,
      `${API_URL}/api/invoices/${invoiceB.invoiceId}`,
      tenantB.authHeaders,
    ); // #1133 workaround

    // ── Both owners mint a real payment link (Mock provider) ────────────
    const linkA = await request.post(`${API_URL}/api/invoices/${invoiceA.invoiceId}/payment-link`, {
      headers: tenantA.authHeaders,
    });
    expect(linkA.ok(), `A payment-link -> ${linkA.status()} ${await linkA.text()}`).toBeTruthy();
    const { url: linkUrlA } = (await linkA.json()) as { url: string };
    expect(linkUrlA).toBeTruthy();

    const linkB = await request.post(`${API_URL}/api/invoices/${invoiceB.invoiceId}/payment-link`, {
      headers: tenantB.authHeaders,
    });
    expect(linkB.ok(), `B payment-link -> ${linkB.status()} ${await linkB.text()}`).toBeTruthy();
    const { url: linkUrlB } = (await linkB.json()) as { url: string };
    expect(linkUrlB).toBeTruthy();

    const beforeVoidA = await request.get(`${API_URL}/api/invoices/${invoiceA.invoiceId}`, {
      headers: tenantA.authHeaders,
    });
    const beforeBodyA = (await beforeVoidA.json()) as {
      status: string;
      stripePaymentLinkUrl?: string;
    };
    expect(beforeBodyA.status).toBe('open');
    expect(beforeBodyA.stripePaymentLinkUrl).toBe(linkUrlA);

    // ── Cross-tenant guard: B cannot void A's invoice ────────────────────
    const crossVoid = await request.post(
      `${API_URL}/api/invoices/${invoiceA.invoiceId}/transition`,
      {
        headers: { 'content-type': 'application/json', ...tenantB.authHeaders },
        data: JSON.stringify({ status: 'void' }),
      },
    );
    expect([403, 404]).toContain(crossVoid.status());
    const stillOpenA = await request.get(`${API_URL}/api/invoices/${invoiceA.invoiceId}`, {
      headers: tenantA.authHeaders,
    });
    expect(((await stillOpenA.json()) as { status: string }).status).toBe('open');

    // ── The owner voids their own invoice through the real HTTP route ───
    const voidRes = await request.post(
      `${API_URL}/api/invoices/${invoiceA.invoiceId}/transition`,
      {
        headers: { 'content-type': 'application/json', ...tenantA.authHeaders },
        data: JSON.stringify({ status: 'void' }),
      },
    );
    expect(voidRes.ok(), `void -> ${voidRes.status()} ${await voidRes.text()}`).toBeTruthy();
    const voided = (await voidRes.json()) as { status: string };
    expect(voided.status).toBe('void');

    // transitionInvoiceStatus (invoice.ts:539) returns the snapshot from its
    // OWN status-only `repository.update` (:554) — BEFORE the link-kill
    // (deactivateInvoicePaymentLink, :583) runs its separate write. The
    // response body is therefore stale on the link fields by design; the
    // durable proof is a re-read, exactly like the #1133 workaround below.
    let afterVoid: { stripePaymentLinkId?: string | null; stripePaymentLinkUrl?: string | null } = {};
    for (let i = 0; i < 20; i++) {
      const r = await request.get(`${API_URL}/api/invoices/${invoiceA.invoiceId}`, {
        headers: tenantA.authHeaders,
      });
      afterVoid = (await r.json()) as typeof afterVoid;
      if (!afterVoid.stripePaymentLinkId) break;
      await new Promise((res) => setTimeout(res, 100));
    }
    expect(afterVoid.stripePaymentLinkId ?? null).toBeNull();
    expect(afterVoid.stripePaymentLinkUrl ?? null).toBeNull();

    // ── Owner's OWN authenticated browser session sees it, durably ──────
    await installClerkStub(page, { signedIn: true, sub: tenantA.ownerSub, token: tenantA.jwt });
    await page.goto(`/invoices/${invoiceA.invoiceId}`);
    await expect(page.getByText('Canceled', { exact: true }).first()).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: join(SCREENSHOT_DIR, '8.7-invoice-voided.png') });

    // ── Durable proof at the DB layer: link fields NULL, audit written ──
    const invoiceRow = await queryAsTenant(
      tenantA.tenantId,
      `SELECT status, stripe_payment_link_id, stripe_payment_link_url FROM invoices WHERE id = $1`,
      [invoiceA.invoiceId],
    );
    expect(invoiceRow).toHaveLength(1);
    expect(invoiceRow[0].status).toBe('void');
    expect(invoiceRow[0].stripe_payment_link_id).toBeNull();
    expect(invoiceRow[0].stripe_payment_link_url).toBeNull();

    const deactivatedAudit = await queryAsTenant(
      tenantA.tenantId,
      `SELECT event_type, metadata FROM audit_events WHERE tenant_id = $1 AND entity_type = 'invoice' AND entity_id = $2 AND event_type = 'invoice.payment_link_deactivated'`,
      [tenantA.tenantId, invoiceA.invoiceId],
    );
    expect(deactivatedAudit).toHaveLength(1);
    expect((deactivatedAudit[0].metadata as { reason?: string }).reason).toBe('voided');

    // ── Tenant B's own invoice + link are completely untouched (T2) ─────
    const invoiceBAfter = await request.get(`${API_URL}/api/invoices/${invoiceB.invoiceId}`, {
      headers: tenantB.authHeaders,
    });
    const bBody = (await invoiceBAfter.json()) as { status: string; stripePaymentLinkUrl?: string };
    expect(bBody.status).toBe('open');
    expect(bBody.stripePaymentLinkUrl).toBe(linkUrlB);

    expect(pageErrors, 'no uncaught page errors during the void journey').toEqual([]);
  });
});
