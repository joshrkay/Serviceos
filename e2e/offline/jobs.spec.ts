import { offlineTest as test, expect } from '../helpers/offline-app';
import {
  createJobsMockState,
  installJobsMocks,
  JOB_A_ID,
} from '../helpers/api-mocks/jobs';
import { DATA_TIMEOUT, type ApiTrackerEntry } from '../helpers/offline-app';

/**
 * Jobs flow — offline real-browser coverage (exemplar for the offline
 * authed suite; estimates/invoices/assistant replicate this shape).
 *
 * What these tests prove that jsdom can't: the REAL bundle renders REAL
 * contract-shaped data (fixtures parse under @ai-service-os/shared schemas
 * on one side, the component reads them on the other — field-mapping drift
 * fails here), route/detail wiring works, and the key mutation sends the
 * request the tracker expects. Business logic is NOT asserted — the API is
 * fake; that proof lives in the real-stack lanes.
 */

test.describe('offline — jobs flow', () => {
  test('list renders schema-parsed fixture data', async ({ page, offlineApp }) => {
    const state = createJobsMockState();
    const tracker: ApiTrackerEntry[] = [];
    await installJobsMocks(page, state, tracker);

    await page.goto('/jobs');

    await expect(page.getByText('Nora Winters').first()).toBeVisible({ timeout: DATA_TIMEOUT });
    await expect(page.getByText('#1042').first()).toBeVisible();
    await expect(page.getByText('AC not cooling — upstairs unit').first()).toBeVisible();
    expect(offlineApp.unmockedApiCalls, 'jobs page traffic fully mocked').toEqual([]);
  });

  test('status tab drives the server-side filter param', async ({ page }) => {
    const state = createJobsMockState();
    const tracker: ApiTrackerEntry[] = [];
    await installJobsMocks(page, state, tracker);

    await page.goto('/jobs');
    await expect(page.getByText('Nora Winters').first()).toBeVisible({ timeout: DATA_TIMEOUT });

    // Status filter tabs are buttons labelled "<Label><count>" (e.g.
    // "Scheduled1"); anchor at start so the tab matches but the job rows
    // (which begin with the service-type emoji) don't.
    await page.getByRole('button', { name: /^scheduled/i }).first().click();

    // The mock filters server-side, so the render proves the param wiring:
    // only the scheduled job remains visible.
    await expect(page.getByText('Miguel Ortega').first()).toBeVisible();
    await expect(page.getByText('Nora Winters')).toHaveCount(0);

    const lastList = [...tracker].reverse().find((t) => t.path === '/api/jobs');
    expect(lastList?.query?.status, 'tab click sends status filter').toBe('scheduled');
    expect(lastList?.query?.page, 'filter change snaps back to page 1').toBe('1');
  });

  test('list row navigates to a rendered detail; deep-link also renders', async ({ page }) => {
    const state = createJobsMockState();
    const tracker: ApiTrackerEntry[] = [];
    await installJobsMocks(page, state, tracker);

    await page.goto('/jobs');
    await expect(page.getByText('Nora Winters').first()).toBeVisible({ timeout: DATA_TIMEOUT });
    await page.getByText('Nora Winters').first().click();

    // Assert on CONTENT, not URL — lazy route chunks settle after the URL.
    await expect(page.getByText('Job #1042').first()).toBeVisible({ timeout: DATA_TIMEOUT });
    await expect(page.getByText('12 Birch Lane', { exact: false }).first()).toBeVisible();

    // Deep-link: detail lives inside the list page component — a direct
    // /jobs/:id load must render the same detail.
    await page.goto(`/jobs/${JOB_A_ID}`);
    await expect(page.getByText('Job #1042').first()).toBeVisible();
  });

  test('status transition sends the exact mutation and re-renders from mutated state', async ({
    page,
  }) => {
    const state = createJobsMockState();
    const tracker: ApiTrackerEntry[] = [];
    await installJobsMocks(page, state, tracker);

    await page.goto(`/jobs/${JOB_A_ID}`);
    await expect(page.getByText('Job #1042').first()).toBeVisible({ timeout: DATA_TIMEOUT });

    // The transition control is a <select title="Change job status">; from
    // status 'new' the only legal option is 'scheduled'.
    await page.getByTitle('Change job status').selectOption('scheduled');

    // Mutation wiring — exact method + path + body (trackers are
    // user-action-triggered, so exact assertions are StrictMode-safe).
    await expect
      .poll(() => tracker.filter((t) => t.method === 'POST').length, {
        message: 'transition mutation reaches the API',
      })
      .toBe(1);
    const mutation = tracker.find((t) => t.method === 'POST');
    expect(mutation?.path).toBe(`/api/jobs/${JOB_A_ID}/transition`);
    expect(mutation?.body).toEqual({ status: 'scheduled' });

    // The post-mutation refetch renders the MUTATED mock state — proving
    // the UI reflects the server's answer, not an optimistic guess.
    await expect(page.getByText(/scheduled/i).first()).toBeVisible();
  });

  test('list 500 renders the error state without an auth exit or page errors', async ({
    page,
    offlineApp,
  }) => {
    const state = createJobsMockState();
    const tracker: ApiTrackerEntry[] = [];
    await installJobsMocks(page, state, tracker);

    // Registered AFTER the domain mocks → wins (last-registered-wins).
    await page.route(
      (url) => url.pathname === '/api/jobs',
      (route) =>
        route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'boom' }),
        }),
    );

    await page.goto('/jobs');

    await expect(page.getByText('Failed to load jobs').first()).toBeVisible({
      timeout: DATA_TIMEOUT,
    });
    // A 500 is a server fault, not an auth failure: no /login exit, no
    // sign-out, and the failure is handled (fixture teardown asserts zero
    // uncaught page errors).
    expect(new URL(page.url()).pathname).toBe('/jobs');
    expect((await offlineApp.clerkCounters()).signOutCalls).toBe(0);
  });
});
