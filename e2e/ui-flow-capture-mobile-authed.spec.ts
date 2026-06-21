import { test } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { UI_FLOW_FIXTURE } from './fixtures/ui-flow-ids';
import { signInMobileOwner } from './helpers/mobile-session';

/**
 * Authenticated mobile UI flow capture — detail screens that need a signed-in
 * session and mocked API payloads (proposal, customer, message thread).
 *
 * Runs under the ui-flow-authed Playwright project (UI_FLOW=1).
 */

const MOBILE_URL = process.env.E2E_MOBILE_URL;
const CAPTURE_DIR = path.resolve(process.cwd(), 'docs/ui-flows/captures/mobile');
const { proposalId, customerId, threadId } = UI_FLOW_FIXTURE;

const DETAIL_SCREENS: Array<{ label: string; path: string }> = [
  { label: 'home', path: '/' },
  { label: 'proposal', path: `/proposals/${proposalId}` },
  { label: 'customer', path: `/customers/${customerId}` },
  { label: 'thread', path: `/messages/${threadId}` },
];

test.use({ viewport: { width: 390, height: 844 } });

test.describe('UI flow capture — mobile (authed detail)', () => {
  test.skip(!process.env.UI_FLOW, 'opt-in via UI_FLOW=1 (see docs/ui-flows/README.md)');
  test.skip(!MOBILE_URL, 'Set E2E_MOBILE_URL to a served expo web export (see file header)');
  test.skip(
    !process.env.E2E_CLERK_USER_USERNAME && !process.env.E2E_CLERK_USER_EMAIL,
    'Mobile authed detail capture needs E2E_CLERK_USER_* — web storageState does not cross origins',
  );

  test.beforeAll(() => {
    fs.mkdirSync(CAPTURE_DIR, { recursive: true });
  });

  test.beforeEach(async ({ page }) => {
    await signInMobileOwner(page, MOBILE_URL!);
  });

  for (const screen of DETAIL_SCREENS) {
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
