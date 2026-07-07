import { offlineTest as test, expect } from '../helpers/offline-app';
import {
  createEstimatesMockState,
  installEstimatesMocks,
  ESTIMATE_A_ID,
} from '../helpers/api-mocks/estimates';
import { DATA_TIMEOUT, type ApiTrackerEntry } from '../helpers/offline-app';

/**
 * Estimates flow — offline real-browser coverage. Proves the list renders
 * schema-parsed data (nested `totals.totalCents` → formatted currency, the
 * exact field-mapping bug class from
 * docs/solutions/test-failures/mocked-client-shape-masks-server-schema-rejection.md),
 * the defaultSelectedId deep-link fires both list + detail queries, and the
 * Send mutation posts a body that parses under the server's send schema.
 */

test.describe('offline — estimates flow', () => {
  test('list renders estimate number, customer, and nested-totals amount', async ({
    page,
    offlineApp,
  }) => {
    const state = createEstimatesMockState();
    const tracker: ApiTrackerEntry[] = [];
    await installEstimatesMocks(page, state, tracker);

    await page.goto('/estimates');

    await expect(page.getByText('Priya Shah').first()).toBeVisible({ timeout: DATA_TIMEOUT });
    await expect(page.getByText('EST-2042').first()).toBeVisible();
    // 125000 cents → "$1,250.00": pins the totals.totalCents → currency mapping.
    await expect(page.getByText('$1,250.00').first()).toBeVisible();
    expect(offlineApp.unmockedApiCalls, 'estimates list traffic fully mocked').toEqual([]);
  });

  test('deep-link /estimates/:id renders detail (list + detail queries both served)', async ({
    page,
  }) => {
    const state = createEstimatesMockState();
    const tracker: ApiTrackerEntry[] = [];
    await installEstimatesMocks(page, state, tracker);

    await page.goto(`/estimates/${ESTIMATE_A_ID}`);

    // Detail content (not URL) — the estimate number + line item render.
    await expect(page.getByText('EST-2042').first()).toBeVisible({ timeout: DATA_TIMEOUT });
    await expect(page.getByText('Condenser coil replacement').first()).toBeVisible();

    // The defaultSelectedId architecture fires BOTH queries.
    expect(tracker.some((t) => t.path === '/api/estimates')).toBe(true);
  });

  test('Send posts a schema-valid body and surfaces the sent state', async ({ page }) => {
    const state = createEstimatesMockState();
    const tracker: ApiTrackerEntry[] = [];
    await installEstimatesMocks(page, state, tracker);

    await page.goto(`/estimates/${ESTIMATE_A_ID}`);
    await expect(page.getByText('EST-2042').first()).toBeVisible({ timeout: DATA_TIMEOUT });

    // Draft → the primary action is "Send to customer", opening the send sheet.
    await page.getByRole('button', { name: /send to customer/i }).first().click();

    // Scope to the send sheet (default channel = SMS) and fill the phone.
    const sheet = page.locator('div.fixed.inset-0.z-50').filter({ hasText: /send via/i });
    await sheet.getByRole('textbox').first().fill('+15551234567');
    await sheet.getByRole('button', { name: /^send /i }).click();

    // Mutation wiring: the intercepted body already parsed under the server's
    // send schema in the mock (a drifted shape would have thrown there).
    await expect
      .poll(() => tracker.filter((t) => t.method === 'POST').length)
      .toBe(1);
    const send = tracker.find((t) => t.method === 'POST');
    expect(send?.path).toBe(`/api/estimates/${ESTIMATE_A_ID}/send`);
    expect(send?.body).toMatchObject({ channel: 'sms', recipientPhone: '+15551234567' });

    // Success UI — the button flips to the sent confirmation.
    await expect(sheet.getByText(/sent!/i).first()).toBeVisible();
  });

  test('detail 500 renders an error state without an auth exit or page errors', async ({
    page,
    offlineApp,
  }) => {
    const state = createEstimatesMockState();
    const tracker: ApiTrackerEntry[] = [];
    await installEstimatesMocks(page, state, tracker);

    await page.route(
      (url) => new RegExp(`/api/estimates/${ESTIMATE_A_ID}$`).test(url.pathname),
      (route) =>
        route.request().method() === 'GET'
          ? route.fulfill({
              status: 500,
              contentType: 'application/json',
              body: JSON.stringify({ error: 'boom' }),
            })
          : route.fallback(),
    );

    await page.goto(`/estimates/${ESTIMATE_A_ID}`);

    // The detail surfaces an error rather than the estimate; no auth exit.
    await expect(page.getByText(/error|failed|try again|couldn.t/i).first()).toBeVisible({
      timeout: DATA_TIMEOUT,
    });
    expect(page.url()).toContain('/estimates');
    expect((await offlineApp.clerkCounters()).signOutCalls).toBe(0);
  });
});
