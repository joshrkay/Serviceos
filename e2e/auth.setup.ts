/**
 * Playwright auth setup — mints a signed-in owner storageState for dependent
 * projects (workflows-authed, ui-flow-authed).
 */
import { test as setup } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  OWNER_AUTH_FILE,
  signInAsOwner,
} from './helpers/clerk-session';
import { hasClerkTestingCreds } from './helpers/clerk-testing';

const OWNER_CREDS_FILE = 'e2e/fixtures/.auth/owner-creds.json';

setup('authenticate owner session', async ({ page }) => {
  setup.setTimeout(120_000);
  setup.skip(!hasClerkTestingCreds(), 'Set E2E_CLERK_* / CLERK_SECRET_KEY for authed E2E');

  mkdirSync(dirname(OWNER_AUTH_FILE), { recursive: true });
  const creds = await signInAsOwner(page);
  await page.context().storageState({ path: OWNER_AUTH_FILE });
  writeFileSync(OWNER_CREDS_FILE, JSON.stringify(creds), 'utf8');
});
