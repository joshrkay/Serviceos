import { test } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  SWEEP_ROUTES,
  PUBLIC_SWEEP_ROUTES,
  type SweepRoute,
} from './helpers/coverage-sweep-routes';
import { setupClerkTestingToken, hasClerkTestingCreds } from './helpers/clerk-testing';

/**
 * UI flow capture (web) — screenshots every web screen so the navigation flow
 * can be assembled into an image map (scripts/build-ui-flow-doc.ts → docs/
 * ui-flows/README.md). Reuses the coverage-sweep route catalog + the Clerk
 * testing-token helper so it stays in sync with the real routes and auth.
 *
 * Opt-in (UI_FLOW=1) so the default `npm run e2e` skips it. Like the coverage
 * sweep it needs a renderable SPA: VITE_CLERK_PUBLISHABLE_KEY locally (main.tsx
 * throws without it) or E2E_BASE_URL pointing at a deployed env that has Clerk
 * wired. Without Clerk creds it runs anonymously — authed routes redirect to
 * /login, so set E2E_CLERK_* for the real screens. See docs/ui-flows/README.md.
 */

const CAPTURE_DIR = path.resolve(process.cwd(), 'docs/ui-flows/captures/web');

// Nav destinations that exist in the app but aren't in the (intentionally
// narrower) coverage-sweep catalog. Captured here so the flow map is complete.
const EXTRA_WEB_ROUTES: SweepRoute[] = [
  { path: '/dispatch', label: 'dispatch', category: 'app' },
  { path: '/comms-inbox', label: 'comms-inbox', category: 'app' },
  { path: '/inbox', label: 'inbox', category: 'app' },
  { path: '/reports/money', label: 'reports-money', category: 'app' },
  { path: '/digest', label: 'digest', category: 'app' },
];

const ROUTES: SweepRoute[] = [...PUBLIC_SWEEP_ROUTES, ...SWEEP_ROUTES, ...EXTRA_WEB_ROUTES];
const canReachSpa = !!process.env.E2E_BASE_URL || !!process.env.VITE_CLERK_PUBLISHABLE_KEY;

test.describe('UI flow capture — web', () => {
  test.skip(!process.env.UI_FLOW, 'opt-in via UI_FLOW=1 (see docs/ui-flows/README.md)');
  test.skip(
    !canReachSpa,
    'Set VITE_CLERK_PUBLISHABLE_KEY (local) or E2E_BASE_URL (deployed) to render the SPA',
  );

  const authed = hasClerkTestingCreds();

  test.beforeAll(() => {
    fs.mkdirSync(CAPTURE_DIR, { recursive: true });
  });

  for (const route of ROUTES) {
    test(`capture ${route.label} — ${route.path}`, async ({ page }) => {
      if (route.category === 'app' && authed) {
        await setupClerkTestingToken(page).catch(() => {
          // No testing token — fall through to the anonymous (redirected) render.
        });
      }
      // Don't fail the capture on a slow/aborted network — we still want the
      // screenshot of whatever painted.
      await page.goto(route.path, { waitUntil: 'networkidle' }).catch(() => undefined);
      await page.waitForTimeout(800); // let async data + entrance animations settle
      await page.screenshot({
        path: path.join(CAPTURE_DIR, `${route.label}.png`),
        fullPage: true,
      });
    });
  }
});
