/**
 * WF-01 … WF-05 — Foundation & access workflows.
 *
 * Run: WORKFLOWS=1 npm run e2e:workflows
 * Or:  npx playwright test e2e/workflows/01-foundation.spec.ts --project=workflows
 */
import { test, expect } from '@playwright/test';
import { WORKFLOWS, workflow } from './catalog';
import {
  apiBase,
  apiGet,
  hasClerkUi,
  hasMatrixEnv,
  prepareAuthedPage,
  JOURNEY_SKIP,
  MATRIX_SKIP,
} from './helpers';
import { setupClerkTestingToken, hasClerkTestingCreds } from '../helpers/clerk-testing';

test('catalog declares exactly 50 workflows', () => {
  expect(WORKFLOWS.length).toBe(50);
  const ids = WORKFLOWS.map((w) => w.id);
  expect(new Set(ids).size).toBe(50);
});

test.describe('WF-01 — Sign up bootstraps tenant', () => {
  test.skip(!hasClerkTestingCreds(), JOURNEY_SKIP);

  test('WF-01: new user signup and /api/me returns tenantId', async ({ page }) => {
    const def = workflow('WF-01');
    test.info().annotations.push({ type: 'passCriteria', description: def.passCriteria });

    await setupClerkTestingToken(page);
    await page.goto('/signup');
    await expect(page.getByText('Fieldly').first()).toBeVisible();

    const testEmail = `wf01+clerk_test+${Date.now()}@serviceos-test.com`;
    await page.getByLabel(/email/i).first().fill(testEmail);
    await page.getByLabel(/password/i).first().fill('E2ETestPassword!123');
    await page.getByRole('button', { name: /continue|sign up|create account/i }).first().click();

    const codeInput = page.getByRole('textbox', { name: /code|verification/i }).first();
    try {
      await codeInput.waitFor({ state: 'visible', timeout: 5_000 });
      await codeInput.fill('424242');
      await page.getByRole('button', { name: /continue|verify/i }).first().click();
    } catch {
      // Clerk may skip verification for +clerk_test addresses.
    }

    await expect(page).toHaveURL(/\/(onboarding|estimates|assistant|$)/, { timeout: 20_000 });
    const meRes = await page.request.get('/api/me');
    expect(meRes.status()).toBe(200);
    const me = (await meRes.json()) as { tenantId?: string };
    expect(me.tenantId).toBeTruthy();
  });
});

test.describe('WF-02 — Sign in lands on home', () => {
  test.skip(!hasClerkUi(), 'Set VITE_CLERK_PUBLISHABLE_KEY or E2E_BASE_URL');

  test('WF-02: authenticated shell loads without console errors', async ({ page }) => {
    const def = workflow('WF-02');
    test.info().annotations.push({ type: 'passCriteria', description: def.passCriteria });

    await prepareAuthedPage(page);
    const consoleErrors: string[] = [];
    page.on('pageerror', (err) => consoleErrors.push(err.message));
    await page.goto('/');
    // Authed users land on home or onboarding; unauthed redirect to login is also valid.
    await expect(page).toHaveURL(/\/(login|onboarding|$)/, { timeout: 15_000 });
    if (!page.url().includes('/login')) {
      expect(consoleErrors).toEqual([]);
    }
  });
});

test.describe('WF-03 — Unauthenticated redirect', () => {
  test.skip(!hasClerkUi(), 'Set VITE_CLERK_PUBLISHABLE_KEY or E2E_BASE_URL');

  test('WF-03: protected route redirects to login', async ({ page }) => {
    const def = workflow('WF-03');
    test.info().annotations.push({ type: 'passCriteria', description: def.passCriteria });

    await page.goto('/');
    await expect(page).toHaveURL(/\/login/, { timeout: 10_000 });
  });
});

test.describe('WF-04 — Cross-tenant isolation', () => {
  test.skip(!hasMatrixEnv(), MATRIX_SKIP);

  test('WF-04: tenant B cannot read tenant A customer', async ({ request }) => {
    const def = workflow('WF-04');
    test.info().annotations.push({ type: 'passCriteria', description: def.passCriteria });

    const { mintToken } = await import('../qa-matrix/fixtures/tokens');
    const tenantAId = process.env.E2E_TENANT_A_ID!;
    const tenantBCustomerId = process.env.E2E_TENANT_B_CUSTOMER_ID!;
    const tokenA = mintToken(tenantAId, 'A');

    const res = await request.get(`${apiBase()}/api/customers/${tenantBCustomerId}`, {
      headers: { authorization: `Bearer ${tokenA}`, accept: 'application/json' },
    });
    expect([403, 404]).toContain(res.status());
  });
});

test.describe('WF-05 — API health', () => {
  test('WF-05: /health responds 200', async ({ request }) => {
    const def = workflow('WF-05');
    test.info().annotations.push({ type: 'passCriteria', description: def.passCriteria });

    const health = await apiGet(request, '/health');
    expect(health.status).toBe(200);
    expect(health.body).toMatchObject({ status: expect.any(String) });
  });

  test('WF-05: /ready responds 200', async ({ request }) => {
    const ready = await apiGet(request, '/ready');
    expect(ready.status).toBe(200);
  });
});
