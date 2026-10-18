import { test, expect, type Page, type Response } from '@playwright/test';

/**
 * "Pick, don't build" onboarding (slices S2a and S2b), against the REAL stack:
 * the draft is created, staged choice by choice, read back and approved
 * through the API's own routes into a real Postgres (e2e/onboarding-v3.config.ts
 * boots both; nothing is mocked).
 *
 * Each test at each viewport runs from a fresh tenant: the browser signs in as
 * a different dev owner per test (the API's DEV_AUTH_BYPASS turns an unsigned
 * token's `sub` into its own tenant), so no test sees another's draft.
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

/** Every screen: nothing wider than the viewport, and every control a glove-sized target. */
async function expectScreenFits(page: Page): Promise<void> {
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  await expectGloveTargets(page);
}

const isStage = (r: Response) => r.url().includes('/api/onboarding/draft/choices/') && r.request().method() === 'PUT';

/** The seven turns, in the order Rivet asks them. */
const QUESTIONS = {
  greeting: 'How should I answer your phone?',
  price: 'What do you charge to come out?',
  posture: 'When someone wants a repair, do I book it or hold it for you?',
  paid: "When a job's done, how do you want to get paid?",
  hours: 'When should I put jobs on your calendar?',
  emergency: 'Who do I ring first when it is an emergency?',
  afterHours: 'Same call at 9pm. Do I answer and book, or take a message?',
} as const;

async function expectTurn(page: Page, question: string): Promise<void> {
  await expect(page.getByRole('heading', { level: 1, name: question })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Keep the rest as is' })).toBeVisible();
  await expectScreenFits(page);
}

/** Select a card, tap the button, and wait for the real stage call to come back OK. */
async function choose(page: Page, label: string, button: 'Next' | 'Save' = 'Next'): Promise<void> {
  const card = page.getByRole('radio', { name: label, exact: true });
  await card.click();
  await expect(card).toHaveAttribute('aria-checked', 'true');
  const saved = page.waitForResponse(isStage);
  await page.getByRole('button', { name: button, exact: true }).click();
  expect((await saved).status()).toBe(200);
}

/** The new owner's first screens: the one question Rivet cannot default, then the finished shop on Ready. */
async function reachReady(page: Page, label: string): Promise<void> {
  await signInAsFreshOwner(page, label);
  await page.goto('/onboarding');

  // A new owner has no draft yet: Rivet asks the one thing it cannot default.
  await expect(page.getByRole('heading', { level: 1, name: 'What should I answer as?' })).toBeVisible();
  await expectScreenFits(page);

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
  await expect(page.getByRole('button', { name: 'Keep the rest as is' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Looks right as is, skip the choices' })).toBeVisible();
  await expectScreenFits(page);
}

for (const vp of viewports) {
  test.describe(`v3 choices and read-back at ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test('Ready, seven choices by tap and by typing, change one from the read-back, "That\'s right" saves them', async ({ page }) => {
      test.setTimeout(90_000);
      await reachReady(page, `${vp.name}-full`);

      // Make it mine -> the first of the seven choices.
      await page.getByRole('button', { name: 'Make it mine, 7 choices' }).click();
      await expectTurn(page, QUESTIONS.greeting);
      await expect(page.getByText('Tap one to hear it. Say "first" or "second" to pick.')).toBeVisible();
      await expect(page.getByRole('radio')).toHaveCount(2);
      await expect(page.getByText('Most shops like yours')).toHaveCount(1);
      await expect(page.getByText('Rivet would say:').first()).toBeVisible();
      await expect(page.getByText('Nothing saved yet')).toBeVisible();
      await expect(page.getByText('About 6 minutes left')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Next' })).toBeDisabled();
      await expect(page.getByRole('button', { name: 'Type instead' })).toBeVisible();

      // 1. Greeting: the second option, not the one most shops pick.
      await choose(page, "Thanks for calling Walsh Plumbing. What's going on today?");

      // 2. Price: typed. A word is refused on the spot, with nothing sent; then dollars go through.
      await expectTurn(page, QUESTIONS.price);
      await expect(page.getByText('About 5 minutes left')).toBeVisible();
      await page.getByRole('button', { name: 'Type instead' }).click();
      await expect(page.getByRole('radio')).toHaveCount(0);
      await page.getByLabel('To come out').fill('cheap');
      await page.getByLabel('Per hour').fill('175');
      await page.getByRole('button', { name: 'Next' }).click();
      await expect(page.getByRole('alert')).toHaveText('Use dollars, like 120 or 89.50.');
      await expectScreenFits(page);
      await page.getByLabel('To come out').fill('$120');
      await expect(page.getByRole('alert')).toHaveCount(0);
      const priceSaved = page.waitForResponse(isStage);
      await page.getByRole('button', { name: 'Next' }).click();
      expect((await priceSaved).status()).toBe(200);

      // 3. Booking: the second option again. 4. Paid, 5. Hours, 6. Emergency: what most shops pick.
      await expectTurn(page, QUESTIONS.posture);
      await expect(page.getByRole('button', { name: 'Type instead' })).toHaveCount(0);
      await choose(page, 'Hold it for me');
      await expectTurn(page, QUESTIONS.paid);
      await choose(page, 'Text them a pay link');
      await expectTurn(page, QUESTIONS.hours);
      await choose(page, 'Monday to Saturday, 7 to 5');
      await expectTurn(page, QUESTIONS.emergency);
      await choose(page, 'Your cell, every time');

      // 7. After hours: the second option. The last turn goes to the read-back, not to an eighth turn.
      await expectTurn(page, QUESTIONS.afterHours);
      await expect(page.getByText('About 3 minutes left')).toBeVisible();
      await choose(page, 'Take a message after hours');

      // The read-back: seven rows with the owner's own answers, and the typed price with no "Typical for" note.
      await expect(page.getByRole('heading', { level: 1, name: "Here's what I've got. Tap anything to change it." })).toBeVisible();
      await expect(page.getByText('Waiting for your OK')).toBeVisible();
      await expect(page.getByRole('list').getByRole('listitem')).toHaveCount(7);
      await expect(page.getByText('$120 to come out, $175 an hour after')).toBeVisible();
      await expect(page.getByText(/Typical for/)).toHaveCount(0);
      await expect(page.getByText("Thanks for calling Walsh Plumbing. What's going on today?")).toBeVisible();
      await expect(page.getByText('Hold it for me')).toBeVisible();
      await expect(page.getByText('Take a message after hours')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Keep the rest as is' })).toHaveCount(0);
      await expectScreenFits(page);

      // Change one: "Getting paid" opens its turn with the current answer chosen, and Save comes back here.
      await page.getByRole('button', { name: /Getting paid/ }).click();
      await expect(page.getByRole('heading', { level: 1, name: QUESTIONS.paid })).toBeVisible();
      await expect(page.getByRole('radio', { name: 'Text them a pay link', exact: true })).toHaveAttribute('aria-checked', 'true');
      await expect(page.getByRole('button', { name: 'Back' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Keep the rest as is' })).toHaveCount(0);
      await expectScreenFits(page);
      await choose(page, 'Collect on the spot', 'Save');
      await expect(page.getByRole('heading', { level: 1, name: "Here's what I've got. Tap anything to change it." })).toBeVisible();
      await expect(page.getByText('Collect on the spot')).toBeVisible();
      await expect(page.getByText('Text them a pay link')).toHaveCount(0);
      await expect(page.getByRole('list').getByRole('listitem')).toHaveCount(7);
      await expectScreenFits(page);

      // That's right -> the real approve route mints and approves two changes, carrying every answer.
      const approved = page.waitForResponse((r) => r.url().endsWith('/api/onboarding/draft/approve') && r.request().method() === 'POST');
      await page.getByRole('button', { name: "That's right" }).click();
      const approveResponse = await approved;
      expect(approveResponse.status()).toBe(200);
      const body = await approveResponse.json();
      expect(body.approvedNow).toBe(true);
      expect(body.proposalIds).toHaveLength(2);
      expect(body.draft.status).toBe('approved');
      expect(body.draft.proposalIds).toEqual(body.proposalIds);
      expect(body.draft.choices).toEqual({
        greeting: { option: 'b' },
        trip_fee_and_rate: {
          override: {
            label: '$120 to come out, then $175 an hour',
            writes: {},
            prices: { tripFeeCents: 12000, hourlyRateCents: 17500 },
          },
        },
        booking_posture: { option: 'b' },
        payment_collection_mode: { option: 'b' },
        booking_hours: { option: 'a' },
        emergency_target: { option: 'a' },
        after_hours_mode: { option: 'b' },
      });

      await expect(page.getByText('Saving 2 changes. They go live in a few seconds.')).toBeVisible();
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    });

    test('Answer two, keep the rest as is, reload: the two choices are still staged and the owner picks up where they left off', async ({ page }) => {
      test.setTimeout(60_000);
      await reachReady(page, `${vp.name}-resume`);
      await page.getByRole('button', { name: 'Make it mine, 7 choices' }).click();

      await expectTurn(page, QUESTIONS.greeting);
      await choose(page, "Thanks for calling Walsh Plumbing. What's going on today?");
      await expectTurn(page, QUESTIONS.price);
      await choose(page, '$129 to come out, then $185 an hour');

      // The third turn is open; "Keep the rest as is" skips straight to the read-back with the typical answers.
      await expectTurn(page, QUESTIONS.posture);
      await page.getByRole('button', { name: 'Keep the rest as is' }).click();
      await expect(page.getByRole('heading', { level: 1, name: "Here's what I've got. Tap anything to change it." })).toBeVisible();
      await expect(page.getByRole('list').getByRole('listitem')).toHaveCount(7);
      await expect(page.getByText("Thanks for calling Walsh Plumbing. What's going on today?")).toBeVisible();
      await expect(page.getByText('$129 to come out, $185 an hour after')).toBeVisible();
      await expect(page.getByText('Book it on the call')).toBeVisible();
      await expectScreenFits(page);

      // Reload (same dev owner token): the server still has exactly the two answers.
      const loaded = page.waitForResponse((r) => r.url().endsWith('/api/onboarding/draft') && r.request().method() === 'GET');
      await page.reload();
      const reloaded = await (await loaded).json();
      expect(reloaded.draft.status).toBe('draft');
      expect(reloaded.draft.choices).toEqual({
        greeting: { option: 'b' },
        trip_fee_and_rate: { option: 'b' },
      });

      // The shell resumes on the first question not yet answered, two of seven done.
      await expectTurn(page, QUESTIONS.posture);
      await expect(page.getByRole('progressbar', { name: 'Setup progress' })).toHaveAttribute('aria-valuenow', '25');
      await expect(page.getByRole('radio', { name: 'Book it on the call', exact: true })).toHaveAttribute('aria-checked', 'false');
      await page.getByRole('button', { name: 'Keep the rest as is' }).click();
      await expect(page.getByRole('heading', { level: 1, name: "Here's what I've got. Tap anything to change it." })).toBeVisible();
      await expect(page.getByText("Thanks for calling Walsh Plumbing. What's going on today?")).toBeVisible();
      await expect(page.getByText('$129 to come out, $185 an hour after')).toBeVisible();
      await expectScreenFits(page);
    });
  });
}
