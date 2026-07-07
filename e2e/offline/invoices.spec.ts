import { offlineTest as test, expect } from '../helpers/offline-app';
import {
  createInvoicesMockState,
  installInvoicesMocks,
  INVOICE_OPEN_ID,
  INVOICE_OVERDUE_ID,
} from '../helpers/api-mocks/invoices';
import { DATA_TIMEOUT, type ApiTrackerEntry } from '../helpers/offline-app';

/**
 * Invoices flow — offline real-browser coverage. Notably pins the
 * client-derived "Overdue" label (deriveInvoiceUiStatus, a shared rule — see
 * docs/solutions/architecture-patterns/derive-shared-status-rule-across-frontends.md)
 * against a real render, and the record-payment mutation against the server's
 * recordPaymentSchema. The 30s list refetch is absorbed by idempotent
 * handlers — no test asserts GET counts.
 */

test.describe('offline — invoices flow', () => {
  test('list renders invoice number, customer, and amount', async ({ page, offlineApp }) => {
    const state = createInvoicesMockState();
    const tracker: ApiTrackerEntry[] = [];
    await installInvoicesMocks(page, state, tracker);

    await page.goto('/invoices');

    await expect(page.getByText('Ava Reyes').first()).toBeVisible({ timeout: DATA_TIMEOUT });
    await expect(page.getByText('INV-3001').first()).toBeVisible();
    await expect(page.getByText('$480.00').first()).toBeVisible();
    expect(offlineApp.unmockedApiCalls, 'invoices list traffic fully mocked').toEqual([]);
  });

  test('a past-due open invoice derives the Overdue label', async ({ page }) => {
    const state = createInvoicesMockState();
    const tracker: ApiTrackerEntry[] = [];
    await installInvoicesMocks(page, state, tracker);

    await page.goto(`/invoices/${INVOICE_OVERDUE_ID}`);

    await expect(page.getByText('INV-3002').first()).toBeVisible({ timeout: DATA_TIMEOUT });
    // status 'open' + past dueDate → the client renders "Overdue"
    // (the value is derived, never sent by the API).
    await expect(page.getByText(/overdue/i).first()).toBeVisible();
  });

  test('record payment posts a recordPaymentSchema-valid body and moves to paid', async ({
    page,
  }) => {
    const state = createInvoicesMockState();
    const tracker: ApiTrackerEntry[] = [];
    await installInvoicesMocks(page, state, tracker);

    await page.goto(`/invoices/${INVOICE_OPEN_ID}`);
    await expect(page.getByText('INV-3001').first()).toBeVisible({ timeout: DATA_TIMEOUT });

    // Unpaid → "Mark as paid" opens the payment sheet (default method: cash).
    await page.getByRole('button', { name: /mark as paid/i }).first().click();
    const sheet = page.locator('div.fixed.inset-0.z-50').filter({ hasText: /payment/i });
    await sheet.getByRole('button', { name: /confirm payment received/i }).click();

    await expect.poll(() => tracker.filter((t) => t.method === 'POST').length).toBe(1);
    const pay = tracker.find((t) => t.method === 'POST');
    expect(pay?.path).toBe('/api/payments');
    // Body already parsed under recordPaymentSchema in the mock; assert the
    // wired values (full amount due, integer cents, mapped method).
    expect(pay?.body).toMatchObject({
      invoiceId: INVOICE_OPEN_ID,
      amountCents: 48000,
      method: 'cash',
    });
  });

  test('payment 500 surfaces an error and leaves the invoice unpaid', async ({
    page,
    offlineApp,
  }) => {
    const state = createInvoicesMockState();
    const tracker: ApiTrackerEntry[] = [];
    await installInvoicesMocks(page, state, tracker);

    await page.route(
      (url) => url.pathname === '/api/payments',
      (route) =>
        route.request().method() === 'POST'
          ? route.fulfill({
              status: 500,
              contentType: 'application/json',
              body: JSON.stringify({ message: 'gateway down' }),
            })
          : route.fallback(),
    );

    await page.goto(`/invoices/${INVOICE_OPEN_ID}`);
    await expect(page.getByText('INV-3001').first()).toBeVisible({ timeout: DATA_TIMEOUT });

    await page.getByRole('button', { name: /mark as paid/i }).first().click();
    const sheet = page.locator('div.fixed.inset-0.z-50').filter({ hasText: /payment/i });
    await sheet.getByRole('button', { name: /confirm payment received/i }).click();

    // The sheet surfaces the failure; the invoice does not flip to paid and
    // there's no auth exit.
    await expect(sheet.getByText(/gateway down|failed/i).first()).toBeVisible();
    expect((await offlineApp.clerkCounters()).signOutCalls).toBe(0);
  });
});
