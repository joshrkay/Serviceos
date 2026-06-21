import { test } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  SWEEP_ROUTES,
  type SweepRoute,
} from './helpers/coverage-sweep-routes';
import { setupClerkTestingToken, hasClerkTestingCreds } from './helpers/clerk-testing';
import { installAuthedShellMocks } from './helpers/clerk-session';

/**
 * Authenticated web UI flow capture — uses Clerk storageState from auth.setup
 * plus route mocks so every back-office screen renders without Postgres.
 *
 * Runs under the ui-flow-authed Playwright project (UI_FLOW=1).
 */

const CAPTURE_DIR = path.resolve(process.cwd(), 'docs/ui-flows/captures/web');

const EXTRA_WEB_ROUTES: SweepRoute[] = [
  { path: '/dispatch', label: 'dispatch', category: 'app' },
  { path: '/comms-inbox', label: 'comms-inbox', category: 'app' },
  { path: '/inbox', label: 'inbox', category: 'app' },
  { path: '/reports/money', label: 'reports-money', category: 'app' },
  { path: '/digest', label: 'digest', category: 'app' },
];

const ROUTES: SweepRoute[] = [...SWEEP_ROUTES, ...EXTRA_WEB_ROUTES];

test.describe('UI flow capture — web (authed)', () => {
  test.skip(!process.env.UI_FLOW, 'opt-in via UI_FLOW=1 (see docs/ui-flows/README.md)');

  test.beforeAll(() => {
    fs.mkdirSync(CAPTURE_DIR, { recursive: true });
  });

  test.beforeEach(async ({ page }) => {
    if (hasClerkTestingCreds()) {
      await setupClerkTestingToken(page).catch(() => undefined);
    }
    await installAuthedShellMocks(page);
  });

  for (const route of ROUTES) {
    test(`capture ${route.label} — ${route.path}`, async ({ page }) => {
      await page.goto(route.path, { waitUntil: 'networkidle' }).catch(() => undefined);
      await page.waitForTimeout(800);
      await page.screenshot({
        path: path.join(CAPTURE_DIR, `${route.label}.png`),
        fullPage: true,
      });
    });
  }
});
