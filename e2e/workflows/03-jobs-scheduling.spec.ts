/**
 * WF-17 … WF-27 — Jobs, scheduling & dispatch workflows.
 */
import { test } from '@playwright/test';
import { workflow } from './catalog';
import {
  assertRouteLoads,
  hasClerkUi,
  prepareAuthedPage,
  MANUAL_SKIP,
  MATRIX_SKIP,
  SWEEP_SKIP,
} from './helpers';

const matrixOnly = ['WF-17', 'WF-19', 'WF-20', 'WF-21'] as const;
for (const id of matrixOnly) {
  test(`${id}: ${workflow(id).title}`, async () => {
    test.skip(true, MATRIX_SKIP);
  });
}

test.describe('WF-18 — Job lifecycle UI', () => {
  test.skip(!hasClerkUi(), SWEEP_SKIP);

  test('WF-18: job detail route renders', async ({ page }) => {
    const def = workflow('WF-18');
    test.info().annotations.push({ type: 'passCriteria', description: def.passCriteria });

    await prepareAuthedPage(page);
    await assertRouteLoads(page, '/jobs/00000000-0000-0000-0000-000000000001');
  });
});

test.describe('WF-22 — Time entry', () => {
  test.skip(!hasClerkUi(), SWEEP_SKIP);

  test('WF-22: technician day view renders', async ({ page }) => {
    const def = workflow('WF-22');
    test.info().annotations.push({ type: 'passCriteria', description: def.passCriteria });

    await prepareAuthedPage(page);
    await assertRouteLoads(page, '/technician/day');
  });
});

test('WF-23: Dispatch drag-assign', async () => {
  test.skip(true, MANUAL_SKIP);
  workflow('WF-23');
});

test('WF-24: Feasibility preview', async () => {
  test.skip(true, MANUAL_SKIP);
  workflow('WF-24');
});

test('WF-25: Approve schedule proposal from dispatch', async () => {
  test.skip(true, MANUAL_SKIP);
  workflow('WF-25');
});

test.describe('WF-26 — Technician day', () => {
  test.skip(!hasClerkUi(), SWEEP_SKIP);

  test('WF-26: technician day route renders', async ({ page }) => {
    const def = workflow('WF-26');
    test.info().annotations.push({ type: 'passCriteria', description: def.passCriteria });

    await prepareAuthedPage(page);
    await assertRouteLoads(page, '/technician/day');
  });
});

test.describe('WF-27 — Tech job view', () => {
  test.skip(!hasClerkUi(), SWEEP_SKIP);

  test('WF-27: jobs list renders for tech navigation', async ({ page }) => {
    const def = workflow('WF-27');
    test.info().annotations.push({ type: 'passCriteria', description: def.passCriteria });

    await prepareAuthedPage(page);
    await assertRouteLoads(page, '/jobs');
  });
});

test.describe('Schedule calendar (WF-19 UI surface)', () => {
  test.skip(!hasClerkUi(), SWEEP_SKIP);

  test('WF-19 UI: schedule calendar route renders', async ({ page }) => {
    const def = workflow('WF-19');
    test.info().annotations.push({ type: 'passCriteria', description: def.passCriteria });
    test.info().annotations.push({ type: 'note', description: 'Full SCH-01 in qa-matrix' });

    await prepareAuthedPage(page);
    await assertRouteLoads(page, '/schedule');
  });
});

test.describe('Dispatch board (WF-23 UI surface)', () => {
  test.skip(!hasClerkUi(), SWEEP_SKIP);

  test('WF-23 UI: dispatch board route renders', async ({ page }) => {
    await prepareAuthedPage(page);
    await assertRouteLoads(page, '/dispatch');
  });
});
