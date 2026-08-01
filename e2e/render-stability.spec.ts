import { test, expect, Page, Route } from '@playwright/test';
import { installClerkStub } from './helpers/clerk-stub';

/**
 * Render-stability E2E — hermetic proof that live list surfaces do NOT
 * flash spinners / blank content on background refresh.
 *
 * Pins the 2026-07-09 fix: useListQuery background refetch keeps
 * `isLoading` false once rows exist, and InvoicesPage no longer unmounts
 * content on poll / visibility catch-up.
 *
 * Pattern mirrors no-401-storm.spec.ts (Clerk stub + in-page API routes).
 * Uses document.visibilitychange to trigger useListQuery's catch-up refetch
 * (same path as the 30s/60s pollers) — avoids page.clock.install() which
 * freezes SPA boot timers.
 */

const hasWebApp =
  !!process.env.E2E_BASE_URL || !!process.env.VITE_CLERK_PUBLISHABLE_KEY;

const isApiUrl = (url: URL) => url.pathname.startsWith('/api/');

async function blockExternalHosts(page: Page, baseURL: string): Promise<void> {
  const appOrigin = new URL(baseURL).origin;
  await page.route(
    (url) => url.origin !== appOrigin,
    (route) => route.abort(),
  );
}

function json(data: unknown): { status: number; contentType: string; body: string } {
  return {
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(data),
  };
}

/** Onboarding shape required by OnboardingGuard (see no-401-storm control). */
const ONBOARDING_COMPLETE = {
  steps: [
    { id: 'signup', status: 'done' },
    { id: 'identity', status: 'done' },
    { id: 'pack', status: 'done' },
    { id: 'phone', status: 'done' },
    { id: 'billing', status: 'done' },
    { id: 'test_call', status: 'done' },
  ],
  currentStep: null,
  isComplete: true,
  tenantId: '00000000-0000-0000-0000-0000000000e2',
  subscriptionStatus: null,
};

const ME = {
  id: 'user_e2e_stub',
  tenantId: '00000000-0000-0000-0000-0000000000e2',
  role: 'owner',
  mode: 'supervisor',
  availableModes: ['supervisor', 'technician'],
  firstName: 'E2E',
  lastName: 'Stub',
  email: 'e2e-stub@example.com',
};

async function dismissWhatsNew(page: Page): Promise<void> {
  const gotIt = page.getByRole('button', { name: /got it/i });
  try {
    await gotIt.waitFor({ state: 'visible', timeout: 2_000 });
    await gotIt.click();
  } catch {
    // Modal not shown — fine.
  }
}

/** Trigger useListQuery visibility catch-up (same as tab refocus). */
async function triggerVisibilityCatchUp(page: Page): Promise<void> {
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => true,
    });
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => false,
    });
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

test.describe('Render stability — no list flicker on background refresh', () => {
  test.skip(
    !hasWebApp,
    'Needs VITE_CLERK_PUBLISHABLE_KEY (or E2E_BASE_URL) so the SPA boots. ' +
      'Any syntactically valid pk_test_ works — Clerk is stubbed offline.',
  );

  test('invoices list keeps rows mounted while a visibility catch-up refetch is in flight', async ({
    page,
    baseURL,
  }) => {
    test.skip(!baseURL, 'Playwright baseURL is required');

    await installClerkStub(page, { signedIn: true });
    await blockExternalHosts(page, baseURL!);

    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    let invoiceListCalls = 0;
    let releasePoll: (() => void) | null = null;
    let pollGate = Promise.resolve();

    const invoiceRow = {
      id: 'inv_stable_1',
      invoiceNumber: 'INV-STABLE-1',
      status: 'open',
      totalCents: 12500,
      amountDueCents: 12500,
      amountPaidCents: 0,
      dueDate: '2026-07-15',
      customer: {
        displayName: 'Stable Customer',
        firstName: 'Stable',
        lastName: 'Customer',
      },
      totals: { totalCents: 12500, subtotalCents: 12500, taxCents: 0 },
      lineItems: [],
    };

    await page.route(isApiUrl, async (route: Route) => {
      const path = new URL(route.request().url()).pathname;

      if (path === '/api/onboarding/status') {
        await route.fulfill(json(ONBOARDING_COMPLETE));
        return;
      }
      if (path === '/api/me') {
        await route.fulfill(json(ME));
        return;
      }
      if (path === '/api/invoices' || path === '/api/invoices/') {
        invoiceListCalls += 1;
        if (invoiceListCalls === 1) {
          await route.fulfill(json({ data: [invoiceRow], total: 1 }));
          return;
        }
        await pollGate;
        await route.fulfill(
          json({
            data: [{ ...invoiceRow, invoiceNumber: 'INV-STABLE-1-REFRESHED' }],
            total: 1,
          }),
        );
        return;
      }
      // List-shaped empties for other shell pollers (jobs, proposals, …).
      if (
        path === '/api/jobs' ||
        path === '/api/estimates' ||
        path === '/api/proposals' ||
        path === '/api/customers' ||
        path === '/api/leads' ||
        path === '/api/appointments' ||
        path.startsWith('/api/proposals/')
      ) {
        if (path.includes('/inbox')) {
          await route.fulfill(
            json({
              data: [],
              summary: { totalCount: 0, criticalCount: 0 },
              expired: [],
              failed: [],
            }),
          );
          return;
        }
        await route.fulfill(json({ data: [], total: 0 }));
        return;
      }
      await route.fulfill(json({}));
    });

    await page.goto('/invoices');
    await dismissWhatsNew(page);

    await expect(page.getByText('INV-STABLE-1')).toBeVisible({ timeout: 20_000 });
    expect(invoiceListCalls).toBeGreaterThanOrEqual(1);
    expect(pageErrors, 'no page errors on first paint').toEqual([]);

    const callsAfterPaint = invoiceListCalls;
    pollGate = new Promise<void>((resolve) => {
      releasePoll = resolve;
    });
    await triggerVisibilityCatchUp(page);

    await expect.poll(() => invoiceListCalls).toBeGreaterThan(callsAfterPaint);

    // Mid-refresh: last-good row still visible; full-page spinner must not appear.
    await expect(page.getByText('INV-STABLE-1')).toBeVisible();
    await expect(page.getByRole('status', { name: 'Loading invoices' })).toHaveCount(0);

    releasePoll?.();
    await expect(page.getByText('INV-STABLE-1-REFRESHED')).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByRole('status', { name: 'Loading invoices' })).toHaveCount(0);
    expect(pageErrors, 'no page errors during background refresh').toEqual([]);
  });

  test('jobs list keeps cards mounted while a visibility catch-up refetch is in flight', async ({
    page,
    baseURL,
  }) => {
    test.skip(!baseURL, 'Playwright baseURL is required');

    await installClerkStub(page, { signedIn: true });
    await blockExternalHosts(page, baseURL!);

    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    let jobListCalls = 0;
    let releasePoll: (() => void) | null = null;
    let pollGate = Promise.resolve();

    const jobRow = {
      id: 'job_stable_1',
      status: 'scheduled',
      uiStatus: 'Scheduled',
      summary: 'AC tune-up — Stable Job',
      serviceType: 'HVAC',
      customer: {
        displayName: 'Stable Job Customer',
        firstName: 'Stable',
        lastName: 'Job',
      },
      scheduledStart: '2026-07-09T15:00:00.000Z',
    };

    await page.route(isApiUrl, async (route: Route) => {
      const path = new URL(route.request().url()).pathname;

      if (path === '/api/onboarding/status') {
        await route.fulfill(json(ONBOARDING_COMPLETE));
        return;
      }
      if (path === '/api/me') {
        await route.fulfill(json(ME));
        return;
      }
      if (path === '/api/jobs' || path === '/api/jobs/') {
        jobListCalls += 1;
        if (jobListCalls === 1) {
          await route.fulfill(json({ data: [jobRow], total: 1 }));
          return;
        }
        await pollGate;
        await route.fulfill(
          json({
            data: [{ ...jobRow, summary: 'AC tune-up — Stable Job (refreshed)' }],
            total: 1,
          }),
        );
        return;
      }
      if (
        path === '/api/invoices' ||
        path === '/api/estimates' ||
        path === '/api/proposals' ||
        path === '/api/customers' ||
        path === '/api/leads' ||
        path === '/api/appointments' ||
        path.startsWith('/api/proposals/')
      ) {
        if (path.includes('/inbox')) {
          await route.fulfill(
            json({
              data: [],
              summary: { totalCount: 0, criticalCount: 0 },
              expired: [],
              failed: [],
            }),
          );
          return;
        }
        await route.fulfill(json({ data: [], total: 0 }));
        return;
      }
      await route.fulfill(json({}));
    });

    await page.goto('/jobs');
    await dismissWhatsNew(page);

    await expect(page.getByText('Stable Job Customer')).toBeVisible({ timeout: 20_000 });
    expect(pageErrors, 'no page errors on first paint').toEqual([]);

    const callsAfterPaint = jobListCalls;
    pollGate = new Promise<void>((resolve) => {
      releasePoll = resolve;
    });
    await triggerVisibilityCatchUp(page);

    await expect.poll(() => jobListCalls).toBeGreaterThan(callsAfterPaint);
    await expect(page.getByText('Stable Job Customer')).toBeVisible();
    await expect(page.getByRole('status', { name: 'Loading jobs' })).toHaveCount(0);

    releasePoll?.();
    await expect(page.getByText('AC tune-up — Stable Job (refreshed)')).toBeVisible({
      timeout: 10_000,
    });
    expect(pageErrors, 'no page errors during background refresh').toEqual([]);
  });
});
