import { test, expect, type Page, type Response } from '@playwright/test';
import { Client } from 'pg';

/**
 * "Pick, don't build" onboarding, slice S4: Undo in the saving window, and the
 * way out of a save that did not go through (Try again, Start over), against the
 * REAL stack (e2e/onboarding-v3.config.ts boots the API on a real Postgres and
 * the SPA with the v3 flag; the draft is approved, undone and reset through the
 * API's own routes, and the screens follow the status the real API derives).
 *
 * A failed save is produced the one way the real world produces it: the two
 * approved changes are put in `execution_failed` in the database (the row state
 * the execution worker writes when a handler fails, as
 * packages/api/test/integration/onboarding-draft-execution.test.ts does) inside
 * the five-second undo window, before the worker may claim them. Nothing in the
 * API is switched into a test mode.
 *
 * Each test at each viewport runs as a fresh dev owner (its own tenant).
 *
 * Run: QA_CHROMIUM_PATH=... npx playwright test -c e2e/onboarding-v3.config.ts
 */
test.skip(
  process.env.E2E_ONBOARDING_V3_STACK !== '1',
  'Needs the real-stack config: npx playwright test -c e2e/onboarding-v3.config.ts',
);

const apiUrl = process.env.E2E_V3_API_URL ?? 'http://127.0.0.1:3011';
const databaseUrl = process.env.E2E_V3_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/serviceos_e2e';

const b64url = (obj: unknown): string => Buffer.from(JSON.stringify(obj)).toString('base64url');

/** The unsigned token the API's dev auth bypass decodes (same shape as the dev Clerk shim mints). */
function devOwnerToken(sub: string): string {
  return `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url({ sub, sid: `session-${sub}`, role: 'owner' })}.x`;
}

async function signInAsFreshOwner(page: Page, label: string): Promise<string> {
  const token = devOwnerToken(`e2e_v3_undo_${label}_${Date.now()}`);
  await page.route('**/api/**', (route) =>
    route.continue({ headers: { ...route.request().headers(), authorization: `Bearer ${token}` } }),
  );
  return token;
}

/** Every visible button, link and field is at least 44px tall. */
async function expectGloveTargets(page: Page): Promise<void> {
  const controls = page.locator('main button:visible, main a[href]:visible, main input:visible, header button:visible');
  const count = await controls.count();
  expect(count).toBeGreaterThan(0);
  for (let i = 0; i < count; i += 1) {
    const box = await controls.nth(i).boundingBox();
    const name = (await controls.nth(i).textContent())?.trim() || `control ${i}`;
    expect(box, name).not.toBeNull();
    expect(box!.height, `${name} is under 44px tall`).toBeGreaterThanOrEqual(44);
  }
}

async function expectScreenFits(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await expectGloveTargets(page);
}

const viewports = [
  { name: '390x844', width: 390, height: 844 },
  { name: '320x568', width: 320, height: 568 },
] as const;

const READBACK_HEADING = "Here's what I've got. Tap anything to change it.";
const OWN_GREETING = "Thanks for calling Walsh Plumbing. What's going on today?";
const TRIAL_HEADING = 'Last thing before your number: start your free trial.';

const isDraftPost = (path: string) => (r: Response) => r.url().endsWith(`/api/onboarding/draft/${path}`) && r.request().method() === 'POST';

/** A new owner answers the greeting with their own pick, keeps the rest, and lands on the read-back. */
async function reachReadback(page: Page, label: string): Promise<string> {
  const token = await signInAsFreshOwner(page, label);
  await page.goto('/onboarding');
  await expect(page.getByRole('heading', { level: 1, name: 'What should I answer as?' })).toBeVisible();
  await page.getByLabel('Business name').fill('Walsh Plumbing');
  await page.getByRole('button', { name: 'Plumbing' }).click();
  await page.getByLabel('Your cell').fill('(216) 555-0142');
  await page.getByRole('button', { name: 'Show me my shop' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Walsh Plumbing is already set up.' })).toBeVisible();

  await page.getByRole('button', { name: 'Make it mine, 7 choices' }).click();
  await page.getByRole('radio', { name: OWN_GREETING, exact: true }).click();
  const staged = page.waitForResponse((r) => r.url().includes('/api/onboarding/draft/choices/') && r.request().method() === 'PUT');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  expect((await staged).status()).toBe(200);
  await page.getByRole('button', { name: 'Keep the rest as is' }).click();
  await expectReadback(page);
  return token;
}

async function expectReadback(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { level: 1, name: READBACK_HEADING })).toBeVisible();
  // The owner's own answer is still there.
  await expect(page.getByText(OWN_GREETING)).toBeVisible();
  await expectScreenFits(page);
}

/** "That's right" through the real approve route; returns the ids it minted. */
async function approve(page: Page): Promise<{ version: number; proposalIds: string[] }> {
  const approved = page.waitForResponse(isDraftPost('approve'));
  await page.getByRole('button', { name: "That's right" }).click();
  const res = await approved;
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { draft: { version: number }; proposalIds: string[]; approvedNow: boolean };
  expect(body.approvedNow).toBe(true);
  return { version: body.draft.version, proposalIds: body.proposalIds };
}

async function statusOf(page: Page, token: string): Promise<{ currentStep: string | null; draft?: Record<string, unknown> }> {
  const res = await page.request.get(`${apiUrl}/api/onboarding/status`, { headers: { authorization: `Bearer ${token}` } });
  expect(res.status()).toBe(200);
  return res.json();
}

for (const vp of viewports) {
  test.describe(`v3 undo and start over at ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test('"That\'s right", Undo inside the window, the read-back again with the answers kept, then approve and it goes live', async ({ page }) => {
      test.setTimeout(120_000);
      const token = await reachReadback(page, `${vp.name}-undo`);

      const first = await approve(page);
      await expect(page.getByRole('heading', { level: 1, name: 'Saving your choices.' })).toBeVisible();
      await expect(page.getByText("Tap Undo if that's not right.")).toBeVisible();
      await expectScreenFits(page);

      // Undo, inside the five seconds: the whole approval comes back.
      const undone = page.waitForResponse(isDraftPost('undo'));
      await page.getByRole('button', { name: 'Undo', exact: true }).click();
      const undoRes = await undone;
      expect(undoRes.status()).toBe(200);
      expect(JSON.parse(undoRes.request().postData() ?? '{}')).toEqual({ expectedVersion: first.version });
      const undoBody = (await undoRes.json()) as { draft: { status: string; version: number; proposalIds: string[] } };
      expect(undoBody.draft).toMatchObject({ status: 'draft', version: first.version + 1, proposalIds: [] });
      await expectReadback(page);
      await expect(page.getByText(/approved|undone|409/i)).toHaveCount(0);

      // Approve again and leave it: the second pair goes live and the setup moves on to the trial.
      const second = await approve(page);
      expect(second.version).toBe(first.version + 2);
      expect(second.proposalIds).not.toEqual(first.proposalIds);
      await expect
        .poll(async () => (await statusOf(page, token)).currentStep, { timeout: 45_000, intervals: [1_000] })
        .toBe('billing');
      await expect(page.getByRole('heading', { level: 1, name: TRIAL_HEADING })).toBeVisible({ timeout: 15_000 });
      await expect(page.getByRole('button', { name: 'Undo', exact: true })).toHaveCount(0);
      await expectScreenFits(page);
    });

    test('a save that did not go through offers Try again and Start over; Start over returns to the read-back with the answers kept', async ({ page }) => {
      test.setTimeout(120_000);
      const token = await reachReadback(page, `${vp.name}-reset`);

      const approved = await approve(page);
      // Both handlers fail, inside the undo window (the worker only claims an approved change after it).
      const db = new Client({ connectionString: databaseUrl });
      await db.connect();
      try {
        const failed = await db.query(
          `UPDATE proposals SET status = 'execution_failed', execution_error = 'e2e: handler failed', execution_retry_count = 3
            WHERE id = ANY($1::uuid[]) AND status = 'approved'`,
          [approved.proposalIds],
        );
        expect(failed.rowCount).toBe(2);
      } finally {
        await db.end();
      }

      // The real status derives a failed set that can still start over.
      await expect
        .poll(async () => (await statusOf(page, token)).draft, { timeout: 15_000, intervals: [500] })
        .toMatchObject({ status: 'approved', execution: 'failed', recovery: 'reset' });
      await expect(page.getByRole('heading', { level: 1, name: "Something didn't save." })).toBeVisible({ timeout: 15_000 });
      await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Start over' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Undo', exact: true })).toHaveCount(0);
      await expectScreenFits(page);

      const reset = page.waitForResponse(isDraftPost('reset'));
      await page.getByRole('button', { name: 'Start over' }).click();
      const resetRes = await reset;
      expect(resetRes.status()).toBe(200);
      expect(JSON.parse(resetRes.request().postData() ?? '{}')).toEqual({ expectedVersion: approved.version });
      await expectReadback(page);

      const after = await statusOf(page, token);
      expect(after.draft).toMatchObject({ status: 'draft', version: approved.version + 1 });
    });
  });
}
