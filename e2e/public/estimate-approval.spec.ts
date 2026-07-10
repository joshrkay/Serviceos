import { test, expect, Page, Route } from '@playwright/test';
import { installClerkStub } from '../helpers/clerk-stub';
import {
  VIEW_TOKEN,
  acceptedEstimateView,
  sentEstimateView,
} from './fixtures/public-estimate-view';

/**
 * W1-3 — Hermetic public estimate approval `/e/:id`.
 *
 * Proves the customer-facing approval page:
 *   - boots without Clerk journey secrets (stub + public mocks)
 *   - renders Zod-pinned estimate chrome with two-decimal money
 *   - happy path: sign → POST /approve → success UI
 *   - negative: network failure → error UI with no fixture-data leak
 *     (Blocker 8 regression)
 *
 * Thread plan: docs/plans/wave1/W1-3-public-estimate-approval.md
 * (branch docs/wave1-prove-money-loop-followup).
 */

const hasWebApp =
  !!process.env.E2E_BASE_URL || !!process.env.VITE_CLERK_PUBLISHABLE_KEY;

/** Fixture customer that must NEVER appear on the error path (Blocker 8). */
const LEAKED_FIXTURE_CUSTOMER = /Sarah Johnson/i;

function json(data: unknown, status = 200) {
  return {
    status,
    contentType: 'application/json',
    body: JSON.stringify(data),
  };
}

async function blockExternalHosts(page: Page, baseURL: string): Promise<void> {
  const appOrigin = new URL(baseURL).origin;
  await page.route(
    (url) => url.origin !== appOrigin,
    (route) => route.abort(),
  );
}

/** Draw a short stroke on the signature canvas so Accept enables. */
async function drawSignature(page: Page): Promise<void> {
  const canvas = page.locator('canvas');
  await expect(canvas).toBeVisible();
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  const x = box!.x + box!.width * 0.2;
  const y = box!.y + box!.height * 0.5;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + box!.width * 0.5, y + 8, { steps: 8 });
  await page.mouse.up();
}

test.describe('W1-3 — public /e/:id estimate approval (hermetic)', () => {
  test.skip(
    !hasWebApp,
    'Needs VITE_CLERK_PUBLISHABLE_KEY (or E2E_BASE_URL) so the SPA boots. ' +
      'Any syntactically valid pk_test_ works — Clerk is stubbed offline. ' +
      'No Clerk journey secrets required.',
  );

  test('approves estimate: money chrome → sign → POST → success UI', async ({
    page,
    baseURL,
  }) => {
    test.skip(!baseURL, 'Playwright baseURL is required');

    await installClerkStub(page, { signedIn: false });
    await blockExternalHosts(page, baseURL!);

    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    const approvePosts: Array<{ path: string; body: Record<string, unknown> }> =
      [];

    await page.route('**/public/estimates/**', async (route: Route) => {
      const req = route.request();
      const url = new URL(req.url());
      const method = req.method();
      const path = url.pathname;

      if (method === 'GET' && path.endsWith(`/public/estimates/${VIEW_TOKEN}`)) {
        await route.fulfill(json(sentEstimateView));
        return;
      }

      if (
        method === 'POST' &&
        path.endsWith(`/public/estimates/${VIEW_TOKEN}/approve`)
      ) {
        const raw = req.postData() ?? '{}';
        const body = JSON.parse(raw) as Record<string, unknown>;
        approvePosts.push({ path, body });
        const name =
          typeof body.acceptedByName === 'string'
            ? body.acceptedByName
            : sentEstimateView.customerName;
        await route.fulfill(json(acceptedEstimateView(name)));
        return;
      }

      // /view beacon and any other POSTs
      if (method === 'POST') {
        await route.fulfill({ status: 204, body: '' });
        return;
      }

      await route.fulfill(json({ error: 'unmocked' }, 404));
    });

    await page.goto(`/e/${VIEW_TOKEN}`);

    // Customer chrome + line items from the Zod-pinned fixture.
    await expect(page.getByText('EST-W1-3001')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/Hi, Morgan!/i)).toBeVisible();
    await expect(page.getByText('River Bend HVAC').first()).toBeVisible();
    await expect(page.getByText('Condenser fan motor')).toBeVisible();
    await expect(page.getByText('Diagnostic labor')).toBeVisible();

    // Money formatting: integer cents → exactly two decimal places.
    // 31000¢ = $310.00 (not "$310" / "$310.0").
    await expect(page.getByText('$310.00').first()).toBeVisible();
    await expect(page.getByText('$185.00').first()).toBeVisible();
    await expect(page.getByText('$125.00').first()).toBeVisible();
    expect(pageErrors, 'no page errors on first paint').toEqual([]);

    await page.getByRole('button', { name: /Accept this estimate/i }).click();

    // Approval sheet — name is prefilled; draw signature to enable submit.
    await expect(page.getByText('Accepting')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'EST-W1-3001' })).toBeVisible();
    await drawSignature(page);

    const acceptBtn = page.getByRole('button', { name: /Accept estimate/i });
    await expect(acceptBtn).toBeEnabled();
    await acceptBtn.click();

    await expect.poll(() => approvePosts.length).toBe(1);
    expect(approvePosts[0].body.acceptedByName).toBe('Morgan Rivera');
    expect(approvePosts[0].body.expectedVersion).toBe(1);
    expect(typeof approvePosts[0].body.signatureData).toBe('string');

    await expect(
      page.getByRole('heading', { name: /Estimate accepted!/i }),
    ).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/Thanks, Morgan!/i)).toBeVisible();
    await expect(page.getByText('$310.00').first()).toBeVisible();
    await expect(page.getByText(/Sarah Johnson/i)).toHaveCount(0);
    expect(pageErrors, 'no page errors through approve → success').toEqual([]);
  });

  test('network failure shows error UI with no fixture-data leak', async ({
    page,
    baseURL,
  }) => {
    test.skip(!baseURL, 'Playwright baseURL is required');

    await installClerkStub(page, { signedIn: false });
    await blockExternalHosts(page, baseURL!);

    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await page.route('**/public/estimates/**', async (route: Route) => {
      await route.abort('failed');
    });

    await page.goto(`/e/${VIEW_TOKEN}`);

    await expect(
      page.getByRole('heading', { name: /Couldn’t load this estimate/i }),
    ).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('button', { name: /Try again/i })).toBeVisible();

    // Blocker 8 — never paint another customer's fixture estimate.
    await expect(page.getByText(LEAKED_FIXTURE_CUSTOMER)).toHaveCount(0);
    await expect(page.getByText(/Fieldly Pro Services/i)).toHaveCount(0);
    await expect(page.getByText('EST-W1-3001')).toHaveCount(0);
    await expect(page.getByText(/Hi, Morgan!/i)).toHaveCount(0);
    expect(pageErrors, 'no page errors on error UI').toEqual([]);
  });
});
