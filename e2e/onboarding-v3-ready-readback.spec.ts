import { test, expect, type Page, type Response } from '@playwright/test';
import { HERMETIC_CHECKOUT_400, HERMETIC_PLANS_503 } from '../packages/web/src/components/onboarding/v3/__fixtures__/after';

/**
 * "Pick, don't build" onboarding (slices S2a, S2b and S2c), against the REAL
 * stack: the draft is created, staged choice by choice, read back and approved
 * through the API's own routes into a real Postgres, and the screens after
 * "That's right" follow the status the real API derives (e2e/onboarding-v3.config.ts
 * boots both; nothing is mocked).
 *
 * Billing is hermetic here (synthetic Stripe keys, no plan prices), so the trial
 * turn is proven against what the real billing routes really answer in that
 * environment. A trial cannot complete, so the number and the test call are
 * proven by component and shell tests (v3/ConversationShell.after.test.tsx).
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

/** Signs the browser in as a new dev owner; returns the token, for a direct call to the real API as that owner. */
async function signInAsFreshOwner(page: Page, label: string): Promise<string> {
  const token = devOwnerToken(`e2e_v3_${label}_${Date.now()}`);
  await page.route('**/api/**', (route) =>
    route.continue({ headers: { ...route.request().headers(), authorization: `Bearer ${token}` } }),
  );
  return token;
}

const apiUrl = process.env.E2E_V3_API_URL ?? 'http://127.0.0.1:3011';

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

/**
 * Records every h1 text the page shows from the start of each document it loads
 * (a MutationObserver installed before any page script runs), so a screen that
 * only flashes on the way to another cannot go unseen by a check made at the end.
 * Applies to every navigation after this call, a reload included.
 */
async function recordHeadings(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { __h1Seen: string[] }).__h1Seen = seen;
    const note = () => {
      const text = document.querySelector('h1')?.textContent?.trim();
      if (text && seen[seen.length - 1] !== text) seen.push(text);
    };
    new MutationObserver(note).observe(document, { childList: true, subtree: true, characterData: true });
    note();
  });
}

const headingsSeen = (page: Page): Promise<string[]> =>
  page.evaluate(() => [...((window as unknown as { __h1Seen?: string[] }).__h1Seen ?? [])]);

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
async function reachReady(page: Page, label: string): Promise<string> {
  const token = await signInAsFreshOwner(page, label);
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
  return token;
}

const isPlans = (r: Response) => r.url().endsWith('/api/onboarding/billing/plans') && r.request().method() === 'GET';
const isApprove = (r: Response) => r.url().endsWith('/api/onboarding/draft/approve') && r.request().method() === 'POST';
const READBACK_HEADING = "Here's what I've got. Tap anything to change it.";
const TRIAL_HEADING = 'Last thing before your number: start your free trial.';
const PLANS_UNAVAILABLE = "I can't show the plans right now. Try again in a minute, or contact support.";

/** The header's two lines and the progress line, read in one go (a screen that is about to change cannot half-match). */
async function headerOf(page: Page): Promise<{ text: string; progress: string | null }> {
  return page.evaluate(() => ({
    text: (document.querySelector('header') as HTMLElement).innerText.replace(/\s+/g, ' ').trim(),
    progress: document.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow') ?? null,
  }));
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
      // The real registry copy: the owner reads two options and taps one; nothing here plays or listens.
      await expect(page.getByText('Pick the one that sounds right.')).toBeVisible();
      await expect(page.getByText(/hear it|say "first"/i)).toHaveCount(0);
      await expect(page.getByRole('radio')).toHaveCount(2);
      await expect(page.getByText('Most shops like yours')).toHaveCount(1);
      // The greeting options already are what Rivet says, so the line is not repeated under them.
      await expect(page.getByText('Rivet would say:')).toHaveCount(0);
      // Focus lands on Rivet's question, so a keyboard or screen-reader owner starts on the new turn.
      await expect(page.getByRole('heading', { level: 1, name: QUESTIONS.greeting })).toBeFocused();
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
      // A slip that is still digits (a phone number's tail) is refused too, not read back as a price.
      await page.getByLabel('Per hour').fill('5550142');
      await page.getByRole('button', { name: 'Next' }).click();
      await expect(page.getByRole('alert')).toHaveText(['Use dollars, like 120 or 89.50.', 'Keep it to $1,000 or less.']);
      await page.getByLabel('Per hour').fill('175');
      await page.getByLabel('To come out').fill('$120');
      await expect(page.getByRole('alert')).toHaveCount(0);
      const priceSaved = page.waitForResponse(isStage);
      await page.getByRole('button', { name: 'Next' }).click();
      expect((await priceSaved).status()).toBe(200);

      // 3. Booking: the second option again. 4. Paid, 5. Hours, 6. Emergency: what most shops pick.
      await expectTurn(page, QUESTIONS.posture);
      await expect(page.getByRole('button', { name: 'Type instead' })).toHaveCount(0);
      await expect(page.getByText('Rivet would say:').first()).toBeVisible();
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

    test('"That\'s right" saves, Rivet gets the shop ready, then the trial turn says what the real billing route says', async ({ page }) => {
      test.setTimeout(120_000);
      const token = await reachReady(page, `${vp.name}-after`);

      await page.getByRole('button', { name: 'Looks right as is, skip the choices' }).click();
      await expect(page.getByRole('heading', { level: 1, name: READBACK_HEADING })).toBeVisible();

      // Listen before the tap: the trial turn asks the real route for its plans the moment it appears.
      const firstPlans = page.waitForResponse(isPlans, { timeout: 40_000 });
      firstPlans.catch(() => undefined);
      const approved = page.waitForResponse(isApprove);
      await page.getByRole('button', { name: "That's right" }).click();
      expect((await approved).status()).toBe(200);

      // 1. The undo window: the choices are being saved.
      await expect(page.getByText('Saving 2 changes. They go live in a few seconds.')).toBeVisible();
      expect(await headerOf(page)).toEqual({ text: 'About 3 minutes left Saving', progress: '60' });
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

      // 2. The window closes and the changes go live a moment later (the API's own timing, about a second):
      //    Rivet says what it is doing. Read in one go, because the next poll moves the screen on.
      await page.getByRole('heading', { level: 1, name: 'Getting your shop ready.' }).waitFor({ state: 'visible', timeout: 20_000 });
      const waiting = await page.evaluate(() => ({
        headings: Array.from(document.querySelectorAll('h1')).map((h) => h.textContent),
        text: (document.querySelector('main') as HTMLElement).innerText,
        controls: document.querySelectorAll('button:not(header button), input, a[href]').length,
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      }));
      expect(waiting.headings).toEqual(['Getting your shop ready.']);
      expect(waiting.text).toContain('This takes a few seconds.');
      expect(waiting.text).not.toContain('taking longer than usual');
      expect(waiting.controls).toBe(0);
      expect(waiting.overflow).toBeLessThanOrEqual(0);

      // 3. The real status reaches billing: the trial.
      await expect(page.getByRole('heading', { level: 1, name: TRIAL_HEADING })).toBeVisible({ timeout: 20_000 });
      expect(await headerOf(page)).toEqual({ text: 'About 3 minutes left Saved', progress: '70' });
      await expect(page.getByText("It's free for 14 days, and you can cancel any time in Settings.")).toBeVisible();
      await expect(page.getByText("You'll add a card on a secure page; nothing is charged for 14 days, and I never see the number.")).toBeVisible();
      // No way out of the trial (a card is what pays for the number).
      await expect(page.locator('header button')).toHaveCount(0);

      // Hermetic billing has no plan prices, so the real route says so; the owner gets words, not the environment.
      const plansResponse = await firstPlans;
      expect(plansResponse.status()).toBe(503);
      expect(await plansResponse.json()).toEqual(HERMETIC_PLANS_503);
      await expect(page.getByRole('alert')).toHaveText(PLANS_UNAVAILABLE);
      await expect(page.getByRole('radio')).toHaveCount(0);
      await expect(page.getByRole('button', { name: /Start my free trial/ })).toHaveCount(0);
      expect(await page.locator('main').innerText()).not.toMatch(/stripe|twilio|\bAI\b|configured|STRIPE_|environment|tenant/i);
      await expectScreenFits(page);

      // Try again asks the real route again, and gets the same honest answer.
      const secondPlans = page.waitForResponse(isPlans);
      await page.getByRole('button', { name: 'Try again' }).click();
      const second = await secondPlans;
      expect(second.status()).toBe(503);
      expect(await second.json()).toEqual(HERMETIC_PLANS_503);
      await expect(page.getByRole('alert')).toHaveText(PLANS_UNAVAILABLE);

      // The route the Start button calls answers the same way for this owner, so the words the turn has
      // for it (component tests) are for what this API really sends.
      const checkoutFor = async (planId: string) => {
        const res = await page.request.post(`${apiUrl}/api/onboarding/billing/checkout-session`, {
          headers: { authorization: `Bearer ${token}` },
          data: { planId },
        });
        return { status: res.status(), body: await res.json() };
      };
      expect(await checkoutFor('starter')).toEqual({ status: 400, body: HERMETIC_CHECKOUT_400 });
      expect(await checkoutFor('growth')).toEqual({
        status: 400,
        body: { error: 'VALIDATION_ERROR', message: 'Billing plan "growth" is not configured (STRIPE_GROWTH_PRICE_ID is not set). Contact support.' },
      });

      // Coming back from the payment page, in both directions, against the real cancel route.
      await recordHeadings(page);
      const cancelled = page.waitForResponse((r) => r.url().endsWith('/api/onboarding/billing/cancel') && r.request().method() === 'POST');
      await page.goto('/onboarding?billing=cancel');
      expect((await cancelled).status()).toBe(200);
      await expect(page.getByText("No problem. Your trial hasn't started. Start it whenever you're ready.")).toBeVisible();
      await expect.poll(() => new URL(page.url()).search).toBe('');
      await expect(page.getByRole('heading', { level: 1, name: TRIAL_HEADING })).toBeVisible();
      await expect(page.getByText('Saving 2 changes')).toHaveCount(0);
      // Measure the settled layout (notice, the plans alert and Try again), not whichever of loading or unavailable is up.
      await expect(page.getByRole('alert')).toHaveText(PLANS_UNAVAILABLE);
      await expectScreenFits(page);

      await page.goto('/onboarding?billing=ok');
      await expect(page.getByText("Thanks. I'm confirming your trial.")).toBeVisible();
      await expect.poll(() => new URL(page.url()).search).toBe('');
      // No payment page ran, so no trial started: the owner is still on the trial turn.
      await expect(page.getByRole('heading', { level: 1, name: TRIAL_HEADING })).toBeVisible();
      await expect(page.getByRole('alert')).toHaveText(PLANS_UNAVAILABLE);
      await expectScreenFits(page);

      // A reload picks up on the same turn, with no saving window and no wait. The headings are recorded
      // from the start of the document, so a wait screen that only shows on the way to the trial is caught.
      await page.reload();
      await expect(page.getByRole('heading', { level: 1, name: TRIAL_HEADING })).toBeVisible();
      await expect(page.getByText('Saving 2 changes')).toHaveCount(0);
      const seenOnReload = await headingsSeen(page);
      expect(seenOnReload.length).toBeGreaterThan(0);
      expect(seenOnReload[0]).toBe(TRIAL_HEADING);
      expect(seenOnReload).not.toContain('Getting your shop ready.');
    });

    test('"Not Cleveland?": the owner changes the city on Ready, the new city and prices show on the price turn and the read-back, and the saved settings carry them', async ({ page }) => {
      test.setTimeout(120_000);
      const token = await reachReady(page, `${vp.name}-metro`);

      // The city the shop was priced for is named, and can be changed with one tap.
      await page.getByRole('button', { name: 'Not Cleveland?' }).click();
      await expect(page.getByRole('searchbox', { name: 'Your city' })).toBeVisible();
      await expectScreenFits(page);
      await page.getByRole('searchbox', { name: 'Your city' }).fill('colum');
      await expect(page.getByRole('list', { name: 'Cities' }).getByRole('button')).toHaveText(['Columbus']);
      const changed = page.waitForResponse((r) => r.url().endsWith('/api/onboarding/draft/metro') && r.request().method() === 'PUT');
      await page.getByRole('list', { name: 'Cities' }).getByRole('button', { name: 'Columbus' }).click();
      const changedResponse = await changed;
      expect(changedResponse.status()).toBe(200);
      expect(changedResponse.request().postDataJSON()).toEqual({ metro: 'CMH', version: 1 });
      const changedBody = await changedResponse.json();
      expect(changedBody.draft).toMatchObject({ metroCode: 'CMH', metroName: 'Columbus', version: 2, choices: {} });

      // Ready now names Columbus and shows Columbus's prices; nothing of Cleveland is left.
      await expect(page.getByText(/the way most Columbus plumbing shops run/)).toBeVisible();
      await expect(page.getByText('$79, then $135 an hour')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Not Columbus?' })).toBeVisible();
      await expect(page.getByText(/Cleveland/)).toHaveCount(0);
      await expectScreenFits(page);

      // The first price turn: Columbus's two options. Picking the premium one stages it against them.
      await page.getByRole('button', { name: 'Make it mine, 7 choices' }).click();
      await expectTurn(page, QUESTIONS.greeting);
      await choose(page, 'Walsh Plumbing, how can I help?');
      await expectTurn(page, QUESTIONS.price);
      await expect(page.getByText("This is the first number a caller hears. Here's where plumbing shops in Columbus land.")).toBeVisible();
      await expect(page.getByRole('radio', { name: '$79 to come out, then $135 an hour', exact: true })).toBeVisible();
      // Once a choice is staged there is no city change anywhere: the read-back names the city as text.
      await choose(page, '$109 to come out, then $165 an hour');
      await expectTurn(page, QUESTIONS.posture);
      await page.getByRole('button', { name: 'Keep the rest as is' }).click();
      await expect(page.getByRole('heading', { level: 1, name: READBACK_HEADING })).toBeVisible();
      await expect(page.getByText('$109 to come out, $165 an hour after')).toBeVisible();
      await expect(page.getByText(/Typical for Columbus plumbers\./)).toBeVisible();
      await expect(page.getByRole('button', { name: /Not Columbus|Set my city/ })).toHaveCount(0);
      await expectScreenFits(page);

      // A stale tab cannot change the city behind the staged pick: the real route refuses it.
      const late = await page.request.put(`${apiUrl}/api/onboarding/draft/metro`, {
        headers: { authorization: `Bearer ${token}` },
        data: { metro: 'CLE', version: 3 },
      });
      expect(late.status()).toBe(409);
      expect((await late.json()).message).toMatch(/^DRAFT_METRO_LOCKED/);

      // That's right: the saved settings, once live, carry the Columbus city and the price the owner picked.
      const approved = page.waitForResponse(isApprove);
      await page.getByRole('button', { name: "That's right" }).click();
      expect((await approved).status()).toBe(200);
      await expect(page.getByText('Saving 2 changes. They go live in a few seconds.')).toBeVisible();
      await expect
        .poll(
          async () => {
            const res = await page.request.get(`${apiUrl}/api/settings`, { headers: { authorization: `Bearer ${token}` } });
            if (!res.ok()) return null;
            const settings = await res.json();
            return { city: settings.serviceAreaText ?? null, hourlyRateCents: settings.hourlyRateCents ?? null };
          },
          { timeout: 40_000, intervals: [1_000] },
        )
        .toEqual({ city: 'Columbus', hourlyRateCents: 16500 });
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
