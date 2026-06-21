/**
 * WF-06 … WF-16 — Onboarding & CRM workflows.
 */
import { test, expect } from '@playwright/test';
import { workflow } from './catalog';
import {
  assertRouteLoads,
  apiBase,
  hasClerkUi,
  hasMatrixEnv,
  matrixTenantAToken,
  prepareAuthedPage,
  JOURNEY_SKIP,
  MANUAL_SKIP,
  MATRIX_SKIP,
  SWEEP_SKIP,
} from './helpers';
import { hasClerkTestingCreds } from '../helpers/clerk-testing';

test.describe('WF-06 — Onboarding v2', () => {
  test.skip(!hasClerkTestingCreds(), JOURNEY_SKIP);

  test('WF-06: onboarding route renders for authed session', async ({ page }) => {
    const def = workflow('WF-06');
    test.info().annotations.push({ type: 'passCriteria', description: def.passCriteria });
    test.info().annotations.push({ type: 'delegate', description: def.delegate ?? '' });

    await prepareAuthedPage(page);
    await assertRouteLoads(page, '/onboarding');
  });
});

test('WF-07: Twilio subaccount provision', async () => {
  test.skip(true, MANUAL_SKIP);
  workflow('WF-07');
});

test('WF-08: Test call confirms agent answers', async () => {
  test.skip(true, MANUAL_SKIP);
  workflow('WF-08');
});

test('WF-09: Stripe subscription / trial start', async () => {
  test.skip(true, MANUAL_SKIP);
  workflow('WF-09');
});

test.describe('WF-10 — Onboarding guard', () => {
  test.skip(!hasClerkUi(), SWEEP_SKIP);

  test('WF-10: /onboarding route is reachable in SPA', async ({ page }) => {
    const def = workflow('WF-10');
    test.info().annotations.push({ type: 'passCriteria', description: def.passCriteria });

    await prepareAuthedPage(page);
    await assertRouteLoads(page, '/onboarding');
  });
});

test.describe('WF-11 — Create customer (UI + API)', () => {
  test.skip(!hasMatrixEnv(), MATRIX_SKIP);

  test('WF-11: POST /api/customers creates a tenant-scoped row', async ({ request }) => {
    const def = workflow('WF-11');
    test.info().annotations.push({ type: 'passCriteria', description: def.passCriteria });

    const stamp = Date.now();
    const res = await request.post(`${apiBase()}/api/customers`, {
      headers: {
        authorization: `Bearer ${matrixTenantAToken()}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      data: {
        firstName: 'WF',
        lastName: `Eleven-${stamp}`,
        primaryPhone: `+1555${String(stamp).slice(-7)}`,
        email: `wf11-${stamp}@example.com`,
        preferredChannel: 'sms',
        smsConsent: true,
      },
    });
    expect(res.status()).toBe(201);
    const body = (await res.json()) as { id?: string };
    expect(body.id).toBeTruthy();
  });
});

test('WF-12: Edit customer + service location', async () => {
  test.skip(true, MATRIX_SKIP);
  workflow('WF-12');
});

test.describe('WF-13 — Customer timeline', () => {
  test.skip(!hasClerkUi(), SWEEP_SKIP);

  test('WF-13: customer detail route renders', async ({ page }) => {
    const def = workflow('WF-13');
    test.info().annotations.push({ type: 'passCriteria', description: def.passCriteria });

    await prepareAuthedPage(page);
    await assertRouteLoads(page, '/customers/00000000-0000-0000-0000-000000000001');
  });
});

test.describe('WF-14 — Leads kanban', () => {
  test.skip(!hasClerkUi(), SWEEP_SKIP);

  test('WF-14: leads list route renders', async ({ page }) => {
    const def = workflow('WF-14');
    test.info().annotations.push({ type: 'passCriteria', description: def.passCriteria });

    await prepareAuthedPage(page);
    await assertRouteLoads(page, '/leads');
  });
});

test('WF-15: Convert lead → customer', async () => {
  test.skip(true, MANUAL_SKIP);
  workflow('WF-15');
});

test.describe('WF-16 — Public intake', () => {
  test.skip(!hasClerkUi(), 'Set VITE_CLERK_PUBLISHABLE_KEY or E2E_BASE_URL');

  test('WF-16: intake page renders public shell', async ({ page }) => {
    const def = workflow('WF-16');
    test.info().annotations.push({ type: 'passCriteria', description: def.passCriteria });

    await assertRouteLoads(page, '/intake');
  });
});
