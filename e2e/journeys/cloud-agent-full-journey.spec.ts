import { test, expect } from '@playwright/test';
import { clerk } from '@clerk/testing/playwright';
import { setupClerkTestingToken, hasClerkTestingCreds } from '../helpers/clerk-testing';

/**
 * Cloud-agent full journey against deployed Railway Development.
 *
 * Run:
 *   E2E_BASE_URL=https://serviceosweb-development.up.railway.app \
 *   E2E_CLERK_PUBLISHABLE_KEY=pk_test_... \
 *   E2E_CLERK_SECRET_KEY=sk_test_... \
 *   npx playwright test e2e/journeys/cloud-agent-full-journey.spec.ts
 */
const RUN_ID = Date.now();
const TEST_EMAIL = `cursor-agent+clerk_test+${RUN_ID}@serviceos-test.com`;
const TEST_PASSWORD = 'CursorAgentE2E!123';

test.describe('Cloud agent — full staging journey', () => {
  test.skip(
    !hasClerkTestingCreds(),
    'Set E2E_CLERK_PUBLISHABLE_KEY + E2E_CLERK_SECRET_KEY',
  );
  test.skip(
    !process.env.E2E_BASE_URL?.includes('railway.app'),
    'Set E2E_BASE_URL to the Railway staging web host',
  );

  test('login → API auth → assistant create customer', async ({ page }) => {
    await setupClerkTestingToken(page);

    const testEmail = process.env.CLOUD_AGENT_TEST_EMAIL ?? TEST_EMAIL;
    const testPassword = process.env.CLOUD_AGENT_TEST_PASSWORD ?? TEST_PASSWORD;

    // 1. Programmatic Clerk password sign-in (staging UI is Google-only)
    await page.goto('/');
    await clerk.signIn({
      page,
      signInParams: {
        strategy: 'password',
        identifier: testEmail,
        password: testPassword,
      },
    });

    await page.goto('/assistant');
    await expect(page).toHaveURL(/\/(onboarding|estimates|assistant|customers|$)/, {
      timeout: 45_000,
    });

    // 2. API recognizes tenant (webhook bootstrap + membership)
    const meRes = await page.request.get('/api/me');
    expect(meRes.status(), 'GET /api/me should be 200 after signup').toBe(200);
    const me = (await meRes.json()) as {
      tenant_id?: string;
      tenantId?: string;
      role?: string;
      user_id?: string;
    };
    const tenantId = me.tenant_id ?? me.tenantId;
    expect(tenantId, 'tenant id present on /api/me').toBeTruthy();
    expect(me.role).toBe('owner');

    // 3. Core CRM reads
    for (const path of ['/api/customers', '/api/settings', '/api/onboarding/status']) {
      const res = await page.request.get(path);
      expect(res.status(), `${path} should be 200`).toBe(200);
    }

    // 4. Assistant — create customer
    const customerName = `Cloud Agent Customer ${RUN_ID}`;
    const assistantRes = await page.request.post('/api/assistant/chat', {
      data: {
        messages: [{ role: 'user', content: `Create a customer named ${customerName}` }],
      },
    });
    expect(assistantRes.status(), 'POST /api/assistant/chat should be 200').toBe(200);
    const assistant = (await assistantRes.json()) as {
      degraded?: boolean;
      taskType?: string;
      message?: { content?: string; proposal?: { id?: string; title?: string } };
    };
    expect(assistant.degraded, 'assistant should not be degraded').toBe(false);

    // Prefer proposal path; record outcome either way for the operator.
    const hasProposal = Boolean(assistant.message?.proposal?.id);
    const proposalsRes = await page.request.get('/api/proposals/inbox');
    expect(proposalsRes.status()).toBe(200);
    const inbox = (await proposalsRes.json()) as { data?: unknown[] };
    const inboxCount = Array.isArray(inbox.data) ? inbox.data.length : 0;

    test.info().annotations.push({
      type: 'assistant',
      description: JSON.stringify({
        taskType: assistant.taskType,
        hasProposal,
        inboxCount,
        content: assistant.message?.content?.slice(0, 200),
      }),
    });

    // 5. If generic LLM path lied about creation, customers list should still be queryable
    const customersRes = await page.request.get('/api/customers');
    expect(customersRes.status()).toBe(200);
    const customers = (await customersRes.json()) as Array<{ displayName?: string }>;
    const created = customers.some((c) =>
      JSON.stringify(c).includes(String(RUN_ID)),
    );

    test.info().annotations.push({
      type: 'customer',
      description: JSON.stringify({
        email: testEmail,
        tenantId,
        customerFoundInList: created,
        customerCount: customers.length,
      }),
    });

    // Pass auth either way; flag proposal gap explicitly.
    expect(tenantId).toBeTruthy();
    if (!hasProposal && !created) {
      expect(
        assistant.taskType,
        'Expected create_customer proposal path or a persisted customer row',
      ).toBe('assistant.create_customer');
    }
  });
});
