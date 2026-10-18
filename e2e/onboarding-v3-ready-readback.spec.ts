import { test, expect, type Page } from '@playwright/test';

/**
 * "Pick, don't build" onboarding, slice S2a, against the REAL stack: the draft
 * is created, read and approved through the API's own routes into a real
 * Postgres (e2e/onboarding-v3.config.ts boots both; nothing is mocked).
 *
 * Each viewport runs the whole flow from a fresh tenant: the browser signs in
 * as a different dev owner per test (the API's DEV_AUTH_BYPASS turns an
 * unsigned token's `sub` into its own tenant), so neither test sees the
 * other's draft.
 *
 * Run: QA_CHROMIUM_PATH=... npx playwright test -c e2e/onboarding-v3.config.ts
 */
test.skip(
  process.env.E2E_ONBOARDING_V3_STACK !== '1',
  'Needs the real-stack config: npx playwright test -c e2e/onboarding-v3.config.ts',
);

const b64url = (obj: unknown): string => Buffer.from(JSON.stringify(obj)).toString('base64url');

/** The unsigned token the API's dev auth bypass decodes (same shape as the dev Clerk shim mints). */
function devOwnerToken(sub: string): string {
  return `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url({ sub, sid: `session-${sub}`, role: 'owner' })}.x`;
}

async function signInAsFreshOwner(page: Page, label: string): Promise<void> {
  const token = devOwnerToken(`e2e_v3_${label}_${Date.now()}`);
  await page.route('**/api/**', (route) =>
    route.continue({ headers: { ...route.request().headers(), authorization: `Bearer ${token}` } }),
  );
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

/** Every visible button and field is at least 44px tall. */
async function expectGloveTargets(page: Page): Promise<void> {
  const controls = page.locator('button:visible, input:visible');
  const count = await controls.count();
  expect(count).toBeGreaterThan(0);
  for (let i = 0; i < count; i += 1) {
    const box = await controls.nth(i).boundingBox();
    const name = (await controls.nth(i).textContent())?.trim() || (await controls.nth(i).getAttribute('id')) || `control ${i}`;
    expect(box, name).not.toBeNull();
    expect(box!.height, `${name} is under 44px tall`).toBeGreaterThanOrEqual(44);
  }
}

const viewports = [
  { name: '390x844', width: 390, height: 844 },
  { name: '320x568', width: 320, height: 568 },
] as const;

for (const vp of viewports) {
  test.describe(`v3 Ready and read-back at ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test('Ready shows the business, "Make it mine" opens the read-back, "That\'s right" saves two changes', async ({ page }) => {
      await signInAsFreshOwner(page, vp.name);
      await page.goto('/onboarding');

      // A new owner has no draft yet: Rivet asks the one thing it cannot default.
      await expect(page.getByRole('heading', { level: 1, name: 'What should I answer as?' })).toBeVisible();
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
      await expectGloveTargets(page);

      await page.getByLabel('Business name').fill('Walsh Plumbing');
      await page.getByRole('button', { name: 'Plumbing' }).click();
      await page.getByLabel('Your cell').fill('(216) 555-0142');
      const created = page.waitForResponse((r) => r.url().endsWith('/api/onboarding/draft') && r.request().method() === 'POST');
      await page.getByRole('button', { name: 'Show me my shop' }).click();
      const createdBody = await (await created).json();
      expect(createdBody.created).toBe(true);
      expect(createdBody.draft.metroCode).toBe('CLE');
      expect(createdBody.draft.clientTimezone).toBeTruthy();

      // Ready: the finished shop, named for the business, priced for Cleveland.
      await expect(page.getByRole('heading', { level: 1, name: 'Walsh Plumbing is already set up.' })).toBeVisible();
      await expect(page.getByText(/the way most Cleveland plumbing shops run/)).toBeVisible();
      await expect(page.getByText('$89, then $150 an hour')).toBeVisible();
      await expect(page.getByText('Most shops').first()).toBeVisible();
      await expect(page.getByText('About 6 minutes left')).toBeVisible();
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
      await expectGloveTargets(page);
      await expect(page.getByRole('button', { name: 'Looks right as is, skip the choices' })).toBeVisible();

      // Make it mine -> the read-back, one row per choice, nothing saved yet.
      await page.getByRole('button', { name: 'Make it mine, 7 choices' }).click();
      await expect(page.getByRole('heading', { level: 1, name: "Here's what I've got." })).toBeVisible();
      await expect(page.getByText('Waiting for your OK')).toBeVisible();
      await expect(page.getByText("Nothing's saved until you say so.")).toBeVisible();
      await expect(page.getByRole('list').getByRole('listitem')).toHaveCount(7);
      await expect(page.getByText('$89 to come out, $150 an hour after')).toBeVisible();
      await expect(page.getByText('Typical for Cleveland plumbers.', { exact: false })).toBeVisible();
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
      await expectGloveTargets(page);

      // That's right -> the real approve route mints and approves two changes.
      const approved = page.waitForResponse((r) => r.url().endsWith('/api/onboarding/draft/approve') && r.request().method() === 'POST');
      await page.getByRole('button', { name: "That's right" }).click();
      const approveResponse = await approved;
      expect(approveResponse.status()).toBe(200);
      const body = await approveResponse.json();
      expect(body.approvedNow).toBe(true);
      expect(body.proposalIds).toHaveLength(2);
      expect(body.draft.status).toBe('approved');
      expect(body.draft.proposalIds).toEqual(body.proposalIds);

      await expect(page.getByText('Saving 2 changes. They go live in a few seconds.')).toBeVisible();
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    });
  });
}
