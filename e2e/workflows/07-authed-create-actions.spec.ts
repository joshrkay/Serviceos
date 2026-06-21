/**
 * Authed-only create-action checks — runs under the workflows-authed project
 * with a signed-in Clerk storageState + API mocks.
 */
import { test } from '@playwright/test';
import { setupClerkTestingToken, hasClerkTestingCreds } from '../helpers/clerk-testing';
import { installAuthedShellMocks } from '../helpers/clerk-session';
import { workflow } from './catalog';
import {
  assertListHasCreateAction,
  isAuthedWorkflowProject,
} from './helpers';

test.describe('Authed create actions', () => {
  test.beforeEach(async ({ page }) => {
    test.skip(!isAuthedWorkflowProject(), 'Requires workflows-authed Playwright project');
    if (hasClerkTestingCreds()) {
      await setupClerkTestingToken(page).catch(() => undefined);
    }
    await installAuthedShellMocks(page);
  });

  test('WF-28: estimates list exposes New estimate', async ({ page }) => {
    const def = workflow('WF-28');
    test.info().annotations.push({ type: 'passCriteria', description: def.passCriteria });
    await assertListHasCreateAction(page, '/estimates', /new estimate/i);
  });

  test('WF-32: invoices list exposes New invoice', async ({ page }) => {
    const def = workflow('WF-32');
    test.info().annotations.push({ type: 'passCriteria', description: def.passCriteria });
    await assertListHasCreateAction(page, '/invoices', /new invoice/i);
  });

  test('WF-17: jobs list exposes New job', async ({ page }) => {
    const def = workflow('WF-17');
    test.info().annotations.push({ type: 'passCriteria', description: def.passCriteria });
    await assertListHasCreateAction(page, '/jobs', /new job/i);
  });
});
