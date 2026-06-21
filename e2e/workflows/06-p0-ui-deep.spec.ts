/**
 * P0 workflow deep checks — UI affordances beyond route-load smoke.
 *
 * Complements the section-grouped specs with cross-cutting P0 assertions
 * that catch unwired CTAs (BUG-4 class) on money/CRM surfaces.
 */
import { test } from '@playwright/test';
import { workflow } from './catalog';
import {
  assertRouteLoads,
  assertListHasCreateAction,
  hasClerkUi,
  isAuthedWorkflowProject,
  prepareAuthedPage,
} from './helpers';

test.describe('P0 UI affordances', () => {
  test.skip(!hasClerkUi(), 'Set VITE_CLERK_PUBLISHABLE_KEY or E2E_BASE_URL');

  test('WF-17 UI: jobs list route renders', async ({ page }) => {
    const def = workflow('WF-17');
    test.info().annotations.push({ type: 'passCriteria', description: def.passCriteria });
    await prepareAuthedPage(page);
    await assertRouteLoads(page, '/jobs');
  });

  test('WF-17 UI: jobs list exposes New job (authed)', async ({ page }) => {
    test.skip(!isAuthedWorkflowProject(), 'Requires workflows-authed project');
    const def = workflow('WF-17');
    test.info().annotations.push({ type: 'passCriteria', description: def.passCriteria });
    await assertListHasCreateAction(page, '/jobs', /new job/i);
  });

  test('WF-14 UI: leads list route renders', async ({ page }) => {
    const def = workflow('WF-14');
    test.info().annotations.push({ type: 'passCriteria', description: def.passCriteria });
    await prepareAuthedPage(page);
    await assertRouteLoads(page, '/leads');
  });

  test('WF-41 UI: inbox shell renders proposal queue surface', async ({ page }) => {
    const def = workflow('WF-41');
    test.info().annotations.push({ type: 'passCriteria', description: def.passCriteria });
    await prepareAuthedPage(page);
    await assertRouteLoads(page, '/inbox');
  });

  test('WF-47 UI: portal shell renders without crashing', async ({ page }) => {
    const def = workflow('WF-47');
    test.info().annotations.push({ type: 'passCriteria', description: def.passCriteria });
    await assertRouteLoads(page, '/portal/00000000-0000-0000-0000-000000000001');
  });

  test('WF-16 UI: booking page renders public shell', async ({ page }) => {
    await assertRouteLoads(page, '/book');
  });
});
