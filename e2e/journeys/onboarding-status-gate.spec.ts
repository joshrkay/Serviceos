import { test, expect } from '@playwright/test';
import { installClerkStub } from '../helpers/clerk-stub';
import { blockExternalHosts } from '../helpers/api-mocks/shell';
import { hasViteClerkKey } from '../helpers/clerk-key';
import { API_URL, bootstrapOwner, pollDbSnapshot } from '../fixtures/onboarding-hermetic-lane';

/**
 * 1.4 + 1.5 — tightly related: both are about `/onboarding`'s derived
 * status being readable and correct AT ANY POINT, through the real
 * browser, rather than a stored linear wizard pointer.
 *
 *   1.4 "close the laptop mid-setup and come back to exactly where I was"
 *       — the current step must be DERIVED from facts (never a stored
 *       flag) and must survive a full page reload, including when steps
 *       were completed OUT OF ORDER.
 *   1.5 "look around before finishing setup" — once identity is saved the
 *       CRM unlocks; remaining steps nudge, they never hard-block.
 *
 * `test/integration/onboarding-status-derived-gate.test.ts` already proves
 * both at the API layer (`request(app)`, never a browser). The actual
 * gate a real owner hits is CLIENT-SIDE
 * (`packages/web/src/components/auth/ProtectedRoute.tsx`'s `OnboardingGuard`
 * — pre-identity every non-/onboarding, non-approval-queue route redirects
 * to /onboarding; post-identity it does not) — this spec drives THAT real
 * browser gate against real Postgres.
 */

const REPORT_DIR = 'setup-8-1-r5';

test.describe('onboarding status derivation + soft gate (1.4 / 1.5) — real Postgres, real browser gate', () => {
  const canRun =
    !process.env.E2E_BASE_URL &&
    hasViteClerkKey() &&
    process.env.E2E_USE_TEST_DB === 'true';
  test.skip(
    !canRun,
    'Requires the local webServer pair against a real Postgres: leave E2E_BASE_URL unset, ' +
      'set VITE_CLERK_PUBLISHABLE_KEY (placeholder ok), and E2E_USE_TEST_DB=true with DATABASE_URL ' +
      'pointing at the test container.',
  );

  test(
    '1.5: /customers hard-redirects to /onboarding before identity is saved, and unlocks the ' +
      'instant identity is saved — remaining steps (phone/billing/AI/test-call) stay incomplete ' +
      'and do NOT re-block it; /inbox is reachable throughout. A neighbour tenant\'s own gate is ' +
      'evaluated independently (T2)',
    async ({ page, baseURL }) => {
      const pageErrors: string[] = [];
      page.on('pageerror', (err) => pageErrors.push(err.message));

      // ── Neighbour, bootstrapped first, never completes identity — its
      //    OWN gate must independently stay locked regardless of what the
      //    tenant under test does later. ───────────────────────────────────
      const neighbour = await bootstrapOwner(page, 'gateneighbour');

      const owner = await bootstrapOwner(page, 'gateowner');
      await installClerkStub(page, { signedIn: true, sub: owner.sub, token: owner.jwt });
      await blockExternalHosts(page, baseURL!);

      // ── Pre-identity: a direct visit to a CRM route hard-redirects back
      //    to /onboarding (soft gate, but still a real block pre-identity). ─
      await page.goto('/customers');
      await expect(page).toHaveURL(/\/onboarding$/, { timeout: 15_000 });
      await page.screenshot({
        path: 'docs/audit/lane-reports/setup-8-1-r5/1.5-pre-identity-customers-redirect.png',
        fullPage: true,
      });

      // The approval queue is explicitly exempt even pre-identity.
      await page.goto('/inbox');
      await expect(page).not.toHaveURL(/\/onboarding$/, { timeout: 15_000 });

      // ── Save identity through the real PUT route (1.2's spec already
      //    proves the FORM leg; this spec's own concern is the GATE, not
      //    re-proving the form). ───────────────────────────────────────────
      const identityRes = await page.request.put(`${API_URL}/api/onboarding/identity`, {
        headers: { 'content-type': 'application/json', ...owner.authHeaders },
        data: JSON.stringify({
          businessName: 'Look Around HVAC',
          businessHours: { mon: { open: '08:00', close: '17:00' }, sat: null, sun: null },
          jobBufferMinutes: 30,
          hourlyRateCents: 15000,
          timezone: 'America/Chicago',
        }),
      });
      expect(identityRes.ok()).toBeTruthy();

      // ── Post-identity: the SAME CRM route now unlocks, with phone /
      //    billing / AI check / test call all still incomplete — a hard
      //    gate on ANY incomplete step would still redirect here; the soft
      //    gate does not. ───────────────────────────────────────────────
      await page.goto('/customers');
      await expect(page).not.toHaveURL(/\/onboarding$/, { timeout: 15_000 });
      await expect(page.getByRole('heading', { name: 'Customers' })).toBeVisible({ timeout: 15_000 });
      await page.screenshot({
        path: 'docs/audit/lane-reports/setup-8-1-r5/1.5-post-identity-customers-unlocked.png',
        fullPage: true,
      });

      // Confirm the remaining steps are genuinely still open (not silently
      // auto-completed by this test) — the unlock is a SOFT gate, not
      // "onboarding secretly finished."
      const statusRes = await page.request.get(`${API_URL}/api/onboarding/status`, {
        headers: owner.authHeaders,
      });
      const status = (await statusRes.json()) as { isComplete?: boolean; currentStep?: string };
      expect(status.isComplete, 'onboarding is NOT complete — the CRM unlock is a nudge, not a finish').toBe(false);

      // ── T2 — the neighbour never touched identity; its OWN gate still
      //      redirects /customers to /onboarding, proving the unlock above
      //      was scoped to the tenant under test, not a global flip. ──────
      await installClerkStub(page, { signedIn: true, sub: neighbour.sub, token: neighbour.jwt });
      await page.goto('/customers');
      await expect(page).toHaveURL(/\/onboarding$/, { timeout: 15_000 });

      pollDbSnapshot(
        REPORT_DIR,
        '1.5-T2-tenant-settings',
        `SELECT tenant_id, business_name FROM tenant_settings WHERE tenant_id IN ` +
          `('${owner.tenantId}','${neighbour.tenantId}') ORDER BY business_name;`,
      );

      expect(pageErrors, 'no uncaught page errors during the soft-gate journey').toEqual([]);
    },
  );

  test(
    '1.4: completing pack BEFORE identity (out of order) still derives correctly in the real ' +
      'browser, and the derived step survives a full page reload ("close the laptop") rather than ' +
      'relying on any client-stored wizard position',
    async ({ page, baseURL }) => {
      const pageErrors: string[] = [];
      page.on('pageerror', (err) => pageErrors.push(err.message));

      const owner = await bootstrapOwner(page, 'ooogateowner');

      // ── Out-of-order: activate the pack BEFORE ever touching identity —
      //    a stored linear "you're on step 1" pointer has no slot for this;
      //    the derivation must read real facts instead. ────────────────────
      const packRes = await page.request.post(`${API_URL}/api/onboarding/pack`, {
        headers: { 'content-type': 'application/json', ...owner.authHeaders },
        data: JSON.stringify({ packId: 'hvac' }),
      });
      expect(packRes.ok(), `out-of-order pack activation -> ${packRes.status()}`).toBeTruthy();

      await installClerkStub(page, { signedIn: true, sub: owner.sub, token: owner.jwt });
      await blockExternalHosts(page, baseURL!);
      await page.goto('/onboarding');

      // The wizard still lands on IDENTITY (the earliest undone step) even
      // though pack — a LATER step — is already done; a stored pointer
      // that only ever advances forward from "step 0" could not represent
      // this at all.
      await expect(page.getByLabel('Business name')).toBeVisible({ timeout: 15_000 });
      const statusAfterPack = await page.request.get(`${API_URL}/api/onboarding/status`, {
        headers: owner.authHeaders,
      });
      const bodyAfterPack = (await statusAfterPack.json()) as {
        currentStep?: string;
        steps?: { id: string; status: string }[];
      };
      expect(bodyAfterPack.currentStep).toBe('identity');
      expect(bodyAfterPack.steps?.find((s) => s.id === 'pack')?.status).toBe('done');
      expect(bodyAfterPack.steps?.find((s) => s.id === 'identity')?.status).toBe('current');

      pollDbSnapshot(
        REPORT_DIR,
        '1.4-out-of-order-status',
        `SELECT tenant_id, business_name FROM tenant_settings WHERE tenant_id = '${owner.tenantId}';`,
      );

      // ── Submit identity through the real form. ───────────────────────────
      await expect(page.getByRole('button', { name: /save and continue/i })).toBeEnabled({
        timeout: 15_000,
      });
      await page.getByLabel('Business name').fill('Out Of Order HVAC');
      const hourlyRateInput = page.locator(
        'xpath=//label[contains(., "Hourly rate")]/following-sibling::div[1]//input[@type="number"]',
      );
      await hourlyRateInput.fill('130');
      const putPromise = page.waitForResponse(
        (r) => r.request().method() === 'PUT' && new URL(r.url()).pathname === '/api/onboarding/identity',
      );
      await page.getByRole('button', { name: /save and continue/i }).click();
      const putRes = await putPromise;
      expect(putRes.status()).toBeLessThan(300);

      // ── "Close the laptop and come back" — a FULL page reload (fresh
      //    fetch of /api/onboarding/status, no client-side wizard state
      //    survives a reload) must land on the step derived from Postgres:
      //    identity + pack both done -> phone next. ─────────────────────────
      await page.reload();
      await expect(page.getByLabel('Business name')).toHaveCount(0, { timeout: 15_000 });
      // Phone is provisioned by the dev-stub worker on signup and often
      // already done by the time this reload lands; accept either the
      // PhoneStep heading or a further-advanced BillingStep heading as
      // proof the derivation moved past identity+pack correctly (never
      // back to pack, which is already done).
      const advanced = page.getByRole('heading', {
        name: /your business number is ready|start your 14-day free trial/i,
      });
      await expect(advanced).toBeVisible({ timeout: 20_000 });
      await page.screenshot({
        path: 'docs/audit/lane-reports/setup-8-1-r5/1.4-after-reload-derived-step.png',
        fullPage: true,
      });

      const statusAfterReload = await page.request.get(`${API_URL}/api/onboarding/status`, {
        headers: owner.authHeaders,
      });
      const bodyAfterReload = (await statusAfterReload.json()) as {
        steps?: { id: string; status: string }[];
      };
      expect(bodyAfterReload.steps?.find((s) => s.id === 'identity')?.status).toBe('done');
      expect(bodyAfterReload.steps?.find((s) => s.id === 'pack')?.status).toBe('done');

      expect(pageErrors, 'no uncaught page errors during the out-of-order derivation journey').toEqual([]);
    },
  );
});
