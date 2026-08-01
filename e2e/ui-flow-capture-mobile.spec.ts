import { test } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * UI flow capture (mobile) — screenshots the Expo operator app at phone
 * viewport so its screens can be assembled into the image flow map alongside
 * the web app (scripts/build-ui-flow-doc.ts).
 *
 * The mobile app is a separate Expo bundle, so this runs against its static web
 * export rather than the Vite SPA. Produce one and point E2E_MOBILE_URL at it:
 *
 *   cd packages/mobile && npm run export:web          # writes .e2e-web/
 *   npx serve packages/mobile/.e2e-web -l 8081        # serve it
 *   UI_FLOW=1 E2E_MOBILE_URL=http://localhost:8081 \
 *     npx playwright test e2e/ui-flow-capture-mobile.spec.ts --project=ui-flow
 *
 * Without a signed-in Clerk session the app redirects to /sign-in (that screen
 * still captures). Detail screens (customer/message/proposal by id) need seeded
 * data and are intentionally omitted from the hub-level tour.
 */

const MOBILE_URL = process.env.E2E_MOBILE_URL;
const CAPTURE_DIR = path.resolve(process.cwd(), 'docs/ui-flows/captures/mobile');

const MOBILE_SCREENS: Array<{ label: string; path: string }> = [
  { label: 'sign-in', path: '/sign-in' },
  { label: 'home', path: '/' },
  { label: 'voice', path: '/voice' },
  { label: 'approvals', path: '/approvals' },
  { label: 'messages', path: '/messages' },
  { label: 'customers', path: '/customers' },
  { label: 'jobs', path: '/jobs' },
  { label: 'estimates', path: '/estimates' },
  { label: 'invoices', path: '/invoices' },
  { label: 'schedule', path: '/schedule' },
  { label: 'settings', path: '/settings' },
];

test.use({ viewport: { width: 390, height: 844 } });

test.describe('UI flow capture — mobile', () => {
  test.skip(!process.env.UI_FLOW, 'opt-in via UI_FLOW=1 (see docs/ui-flows/README.md)');
  test.skip(!MOBILE_URL, 'Set E2E_MOBILE_URL to a served expo web export (see file header)');

  test.beforeAll(() => {
    fs.mkdirSync(CAPTURE_DIR, { recursive: true });
  });

  for (const screen of MOBILE_SCREENS) {
    test(`capture mobile ${screen.label}`, async ({ page }) => {
      await page.goto(`${MOBILE_URL}${screen.path}`, { waitUntil: 'networkidle' }).catch(
        () => undefined,
      );
      await page.waitForTimeout(800);
      await page.screenshot({
        path: path.join(CAPTURE_DIR, `${screen.label}.png`),
        fullPage: true,
      });
    });
  }
});
