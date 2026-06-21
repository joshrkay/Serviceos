/**
 * WF-28 … WF-35 — Money loop workflows.
 */
import { test } from '@playwright/test';
import { workflow } from './catalog';
import {
  assertRouteLoads,
  hasClerkUi,
  prepareAuthedPage,
  JOURNEY_SKIP,
  MATRIX_SKIP,
} from './helpers';

const matrixMoney = ['WF-28', 'WF-30', 'WF-31', 'WF-32', 'WF-34', 'WF-35'] as const;
for (const id of matrixMoney) {
  test(`${id}: ${workflow(id).title}`, async () => {
    test.skip(true, MATRIX_SKIP);
  });
}

test('WF-29: Send estimate to customer', async () => {
  test.skip(true, JOURNEY_SKIP);
  workflow('WF-29');
});

test('WF-33: Customer pays on /pay/:id', async () => {
  test.skip(true, JOURNEY_SKIP);
  workflow('WF-33');
});

test.describe('WF-28 UI — Estimates list', () => {
  test.skip(!hasClerkUi(), 'Set VITE_CLERK_PUBLISHABLE_KEY or E2E_BASE_URL');

  test('WF-28 UI: estimates list route renders', async ({ page }) => {
    const def = workflow('WF-28');
    test.info().annotations.push({ type: 'passCriteria', description: def.passCriteria });
    test.info().annotations.push({ type: 'note', description: 'Create-action wired in 07-authed-create-actions.spec.ts' });

    await prepareAuthedPage(page);
    await assertRouteLoads(page, '/estimates');
  });
});

test.describe('WF-32 UI — Invoices', () => {
  test.skip(!hasClerkUi(), 'Set VITE_CLERK_PUBLISHABLE_KEY or E2E_BASE_URL');

  test('WF-32 UI: invoices list route renders', async ({ page }) => {
    const def = workflow('WF-32');
    test.info().annotations.push({ type: 'passCriteria', description: def.passCriteria });
    test.info().annotations.push({ type: 'note', description: 'Create-action wired in 07-authed-create-actions.spec.ts' });

    await prepareAuthedPage(page);
    await assertRouteLoads(page, '/invoices');
  });
});

test.describe('WF-35 UI — Money dashboard', () => {
  test.skip(!hasClerkUi(), 'Set VITE_CLERK_PUBLISHABLE_KEY or E2E_BASE_URL');

  test('WF-35 UI: money report route renders', async ({ page }) => {
    const def = workflow('WF-35');
    test.info().annotations.push({ type: 'passCriteria', description: def.passCriteria });

    await prepareAuthedPage(page);
    await assertRouteLoads(page, '/reports/money');
  });
});

test.describe('WF-30 UI — Public estimate approval', () => {
  test.skip(!hasClerkUi(), 'Set VITE_CLERK_PUBLISHABLE_KEY or E2E_BASE_URL');

  test('WF-30 UI: estimate approval route shell renders', async ({ page }) => {
    const def = workflow('WF-30');
    test.info().annotations.push({ type: 'passCriteria', description: def.passCriteria });
    test.info().annotations.push({ type: 'note', description: 'Full PORT-01 in qa-matrix with token' });

    await assertRouteLoads(page, '/e/00000000-0000-0000-0000-000000000001');
  });
});

test.describe('WF-33 UI — Public invoice payment', () => {
  test.skip(!hasClerkUi(), 'Set VITE_CLERK_PUBLISHABLE_KEY or E2E_BASE_URL');

  test('WF-33 UI: payment route shell renders', async ({ page }) => {
    const def = workflow('WF-33');
    test.info().annotations.push({ type: 'passCriteria', description: def.passCriteria });

    await assertRouteLoads(page, '/pay/00000000-0000-0000-0000-000000000001');
  });
});
