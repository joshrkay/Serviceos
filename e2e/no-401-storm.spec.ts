import { test, expect, Page, Route } from '@playwright/test';
import { installClerkStub, readClerkStubCounters } from './helpers/clerk-stub';

/**
 * 401-storm regression suite — real-browser proof for the 2026-07-06 fix
 * ("stop the 401 redirect storm and phantom error states").
 *
 * The outage shape being pinned: the API persistently 401s a session the
 * Clerk client still considers valid. Pre-fix, every fetch layer redirected
 * to /login via a full page reload; LoginPage saw isSignedIn and bounced
 * straight back; every root-mounted fetch refired — an unbounded app↔login
 * reload loop that hammered the API. The fix routes persistent 401s through
 * ONE latched Clerk sign-out (lib/apiClient.ts handleAuthFailure), gates the
 * /api/me identity bridges on isSignedIn, and makes a 401 on /login a no-op.
 *
 * jsdom tests (apiClient.test.ts, api-fetch.test.ts) pin the unit logic.
 * This suite proves the SYSTEM property in a real Chromium running the real
 * bundle: we recreate the outage locally — a stubbed signed-in Clerk (see
 * helpers/clerk-stub.ts, no network needed) plus route-mocked 401s on every
 * /api/* request — and then COUNT what the app does:
 *
 *   - sign-out fires exactly once across N concurrent 401s (the latch)
 *   - one soft navigation lands on /login; zero further document loads
 *     (a reload loop is quantitatively visible here — pre-fix this counter
 *     climbs unbounded)
 *   - after landing on /login the network goes quiet (bridges gated,
 *     pollers unmounted, latch holds)
 *   - a signed-out /login never fetches /api/me at all
 *
 * Runs fully offline: no Clerk egress, no API needed (routes are fulfilled
 * in-page), so it works in sandboxes and PR CI alike.
 */

const hasWebApp =
  !!process.env.E2E_BASE_URL || !!process.env.VITE_CLERK_PUBLISHABLE_KEY;

/**
 * True only for real API calls. A glob like `**\/api\/**` would also match
 * Vite's dev-server module URLs (/src/api/me.ts, /src/api/jobs.ts, …) and
 * 401 the app's own source files — killing the boot before any fetch fires.
 */
const isApiUrl = (url: URL) => url.pathname.startsWith('/api/');

/** Per-path hit counter over all /api/* requests, fulfilled with a 401. */
async function intercept401s(page: Page): Promise<Map<string, number>> {
  const hits = new Map<string, number>();
  await page.route(isApiUrl, async (route: Route) => {
    const path = new URL(route.request().url()).pathname;
    hits.set(path, (hits.get(path) ?? 0) + 1);
    await route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'unauthorized' }),
    });
  });
  return hits;
}

function totalHits(hits: Map<string, number>): number {
  let n = 0;
  for (const count of hits.values()) n += count;
  return n;
}

test.describe('401 resilience — no redirect storm', () => {
  test.skip(
    !hasWebApp,
    'Set VITE_CLERK_PUBLISHABLE_KEY locally or E2E_BASE_URL to run UI E2E tests',
  );

  test('persistent 401s: one latched sign-out, one soft landing on /login, then silence', async ({
    page,
  }) => {
    await installClerkStub(page, { signedIn: true });
    const hits = await intercept401s(page);

    let documentLoads = 0;
    page.on('load', () => {
      documentLoads += 1;
    });
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    // Land on an authed route. Every /api/* fetch the shell fires (onboarding
    // status, /api/me bridges, jobs list, pollers) gets a 401 → each retries
    // once with a refreshed token → still 401 → handleAuthFailure.
    await page.goto('/jobs');

    // The fix's exit: latched sign-out → signed-out state → ProtectedRoute
    // navigates to /login. Pre-fix this URL oscillated /jobs↔/login forever.
    await page.waitForURL(/\/login/, { timeout: 15_000 });

    // Quiet window — the core anti-storm property. Once the latch has
    // tripped and the app is signed-out on /login, NOTHING may keep firing:
    // identity bridges are gated on isSignedIn, pollers unmounted with the
    // authed shell. Pre-fix, the reload loop kept the request counter
    // climbing without bound.
    await page.waitForTimeout(2_000);
    const settled = totalHits(hits);
    await page.waitForTimeout(2_500);
    expect(totalHits(hits), 'no /api requests may fire after landing on /login').toBe(
      settled,
    );

    // The latch: N concurrent 401 handlers, exactly ONE Clerk sign-out.
    const counters = await readClerkStubCounters(page);
    expect(counters.signOutCalls, 'persistent-401 exit must sign out exactly once').toBe(1);

    // No reload loop: the only document load is the initial goto. The
    // pre-fix redirect (window.location.href) would add one per bounce.
    expect(documentLoads, 'no full page reloads after the initial navigation').toBe(1);

    // Soft-landing on /login via the sign-out path (no ?redirect= — that
    // query is the legacy hard-redirect fallback, kept for when no sign-out
    // handler is wired).
    expect(new URL(page.url()).pathname).toBe('/login');

    // Bounded per-endpoint volume: original + one forced-refresh retry per
    // caller. /api/me legitimately has two consumers (analytics bridge +
    // timezone provider) and dev StrictMode double-invokes mount effects, so
    // allow that headroom — the storm this guards against produced hundreds.
    for (const [path, count] of hits.entries()) {
      expect(count, `bounded request volume for ${path}`).toBeLessThanOrEqual(8);
    }

    expect(pageErrors, 'no uncaught page errors during the 401 flood').toEqual([]);
  });

  test('signed-out /login: identity bridges stay quiet — zero /api traffic, no loop', async ({
    page,
  }) => {
    await installClerkStub(page, { signedIn: false });
    const hits = await intercept401s(page);

    let documentLoads = 0;
    page.on('load', () => {
      documentLoads += 1;
    });
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await page.goto('/login');

    // Pre-fix, AnalyticsIdentityBridge + TenantTimezoneProvider mounted
    // outside the router and fired /api/me even on /login — each answer a
    // 401 feeding the loop. Post-fix they gate on isLoaded && isSignedIn.
    await page.waitForTimeout(3_000);
    expect(totalHits(hits), 'a signed-out /login must fire no /api requests').toBe(0);

    expect(new URL(page.url()).pathname).toBe('/login');
    expect(documentLoads, 'login page must not reload itself').toBe(1);

    const counters = await readClerkStubCounters(page);
    expect(counters.signOutCalls).toBe(0);
    expect(pageErrors).toEqual([]);
  });

  test('healthy API control: signed-in stays on the app, sign-out never fires', async ({
    page,
  }) => {
    await installClerkStub(page, { signedIn: true });

    // Control for the storm test: with the API answering 200s, the exact
    // same signed-in boot must NOT trip the auth-failure exit. This proves
    // the storm test's sign-out came from the 401s, not from the harness.
    // Responses are shape-minimal; the assertions here are about routing
    // and the latch, not rendering.
    await page.route(isApiUrl, async (route: Route) => {
      const path = new URL(route.request().url()).pathname;
      const body =
        path === '/api/onboarding/status'
          ? {
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
            }
          : {};
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(body),
      });
    });

    let documentLoads = 0;
    page.on('load', () => {
      documentLoads += 1;
    });

    await page.goto('/jobs');
    await page.waitForTimeout(3_000);

    expect(new URL(page.url()).pathname, 'healthy signed-in session stays on the app').toBe(
      '/jobs',
    );
    const counters = await readClerkStubCounters(page);
    expect(counters.signOutCalls, 'no sign-out on a healthy API').toBe(0);
    expect(documentLoads).toBe(1);
  });
});
