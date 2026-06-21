/**
 * WF-36 … WF-50 — AI proposals, voice, public & integrations workflows.
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

const manualInbox = ['WF-36', 'WF-37', 'WF-38'] as const;
for (const id of manualInbox) {
  test(`${id}: ${workflow(id).title}`, async () => {
    test.skip(true, MANUAL_SKIP);
  });
}

test('WF-39: Assistant chat → estimate proposal', async () => {
  test.skip(true, MATRIX_SKIP);
  workflow('WF-39');
});

test('WF-42: Inbound call booking proposal', async () => {
  test.skip(true, MATRIX_SKIP);
  workflow('WF-42');
});

test('WF-43: Emergency escalation', async () => {
  test.skip(true, MATRIX_SKIP);
  workflow('WF-43');
});

test('WF-44: Recording → interaction log', async () => {
  test.skip(true, MATRIX_SKIP);
  workflow('WF-44');
});

test('WF-45: In-app voice session', async () => {
  test.skip(true, MANUAL_SKIP);
  workflow('WF-45');
});

test('WF-47: Customer portal token scope', async () => {
  test.skip(true, MATRIX_SKIP);
  workflow('WF-47');
});

test('WF-48: Portal request service', async () => {
  test.skip(true, MANUAL_SKIP);
  workflow('WF-48');
});

test('WF-50: Google Calendar sync', async () => {
  test.skip(true, 'API route tests in packages/api — calendar-integrations.route.test.ts');
  workflow('WF-50');
});

test.describe('WF-40 — Voice bar', () => {
  test.skip(!hasClerkUi(), SWEEP_SKIP);

  test('WF-40 UI: home dashboard renders voice entry point', async ({ page }) => {
    const def = workflow('WF-40');
    test.info().annotations.push({ type: 'passCriteria', description: def.passCriteria });

    await prepareAuthedPage(page);
    await assertRouteLoads(page, '/');
  });
});

test.describe('WF-41 — Inbox navigation', () => {
  test.skip(!hasClerkUi(), SWEEP_SKIP);

  test('WF-41 UI: inbox route renders', async ({ page }) => {
    const def = workflow('WF-41');
    test.info().annotations.push({ type: 'passCriteria', description: def.passCriteria });

    await prepareAuthedPage(page);
    await assertRouteLoads(page, '/inbox');
  });
});

test.describe('WF-46 — Interactions transcript', () => {
  test.skip(!hasClerkUi(), SWEEP_SKIP);

  test('WF-46: interactions route renders', async ({ page }) => {
    const def = workflow('WF-46');
    test.info().annotations.push({ type: 'passCriteria', description: def.passCriteria });

    await prepareAuthedPage(page);
    await assertRouteLoads(page, '/interactions');
  });
});

test.describe('WF-39 UI — Assistant', () => {
  test.skip(!hasClerkUi(), SWEEP_SKIP);

  test('WF-39 UI: assistant route renders', async ({ page }) => {
    await prepareAuthedPage(page);
    await assertRouteLoads(page, '/assistant');
  });
});

test.describe('WF-49 — Feedback', () => {
  test.skip(!hasClerkUi(), SWEEP_SKIP);

  test('WF-49 UI: public feedback route shell renders', async ({ page }) => {
    const def = workflow('WF-49');
    test.info().annotations.push({ type: 'passCriteria', description: def.passCriteria });

    await assertRouteLoads(page, '/feedback/00000000-0000-0000-0000-000000000001');
  });
});

test.describe('WF-47 UI — Portal shell', () => {
  test.skip(!hasClerkUi(), SWEEP_SKIP);

  test('WF-47 UI: customer portal route shell renders', async ({ page }) => {
    const def = workflow('WF-47');
    test.info().annotations.push({ type: 'passCriteria', description: def.passCriteria });
    test.info().annotations.push({ type: 'note', description: 'Full PORTAL-01 in qa-matrix with token' });

    await assertRouteLoads(page, '/portal/00000000-0000-0000-0000-000000000001');
  });
});

test.describe('WF-16 UI — Booking', () => {
  test.skip(!hasClerkUi(), SWEEP_SKIP);

  test('WF booking UI: public booking route renders', async ({ page }) => {
    await assertRouteLoads(page, '/book');
  });
});
