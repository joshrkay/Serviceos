import { test, expect, type Page, type Request } from '@playwright/test';

/**
 * Rivet's voice in the "pick, don't build" onboarding shell (slice S3, plan
 * U4), against the REAL stack (e2e/onboarding-v3.config.ts): the shell asks the
 * API's own voice routes for each turn's lines and the routes answer for real.
 *
 * S3-3 (Rivet speaks) proves here what Chromium can prove with no voice key:
 * the lane boots the API with no speech provider, so the real routes answer
 * 501 and the shell must fall back without a dead end. Every turn is still
 * answerable by tap, nothing raises an alert, each choice turn's lines go out
 * as one request of at most three clips, the next turn is asked for while the
 * current one is on screen and never two turns ahead, and a full pass is 21
 * clips.
 *
 * S3-5 (Rivet listens) proves the listening half's degrade on the real routes:
 * the lane has no transcription key, so whether the browser refuses the
 * microphone (Playwright's default) or grants it (the fake device) and the real
 * POST /api/voice/stream-token answers 503, the turn has no mic, no alert,
 * the greeting keeps only "Tap one to hear it." (the listening half is never
 * promised where nothing listens), and every turn is answered by tap. A live
 * transcription run needs a Deepgram key and a microphone: a device run
 * through the web verify skill (owner action). S3-6 extends this file with the
 * dev-only fixture voice (audio that really plays after the gesture) and the
 * WebKit project.
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

/** Signs the browser in as a new dev owner (its own tenant), so no test sees another's draft or clip budget. */
async function signInAsFreshOwner(page: Page, label: string): Promise<void> {
  const token = devOwnerToken(`e2e_v3_voice_${label}_${Date.now()}`);
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
    const name = (await controls.nth(i).textContent())?.trim() || `control ${i}`;
    expect(box, name).not.toBeNull();
    expect(box!.height, `${name} is under 44px tall`).toBeGreaterThanOrEqual(44);
  }
}

async function expectScreenFits(page: Page): Promise<void> {
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  await expectGloveTargets(page);
}

/** The seven turns, in the order Rivet asks them. */
const QUESTIONS = [
  'How should I answer your phone?',
  'What do you charge to come out?',
  'When someone wants a repair, do I book it or hold it for you?',
  "When a job's done, how do you want to get paid?",
  'When should I put jobs on your calendar?',
  'Who do I ring first when it is an emergency?',
  'Same call at 9pm. Do I answer and book, or take a message?',
] as const;
const READBACK_HEADING = "Here's what I've got. Tap anything to change it.";

interface VoiceCall {
  path: string;
  items: string[];
  status?: number;
}

/** Every request the shell makes to the voice routes, with what it asked for and what the real API answered. */
function recordVoice(page: Page): VoiceCall[] {
  const calls: VoiceCall[] = [];
  const byRequest = new Map<Request, VoiceCall>();
  page.on('request', (req) => {
    const url = new URL(req.url());
    if (!url.pathname.startsWith('/api/voice/tts')) return;
    const body = (req.postDataJSON() ?? {}) as { items?: string[]; text?: string };
    const call: VoiceCall = { path: url.pathname, items: body.items ?? (body.text ? [body.text] : []) };
    calls.push(call);
    byRequest.set(req, call);
  });
  page.on('response', (res) => {
    const call = byRequest.get(res.request());
    if (call) call.status = res.status();
  });
  return calls;
}

const batches = (calls: VoiceCall[]) => calls.filter((c) => c.path === '/api/voice/tts/batch');

const viewports = [
  { name: '390x844', width: 390, height: 844 },
  { name: '320x568', width: 320, height: 568 },
] as const;

for (const vp of viewports) {
  test.describe(`v3 voice at ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test('every turn speaks through one request of at most three clips, a full pass is 21, and a voiceless API never blocks a tap', async ({
      page,
    }) => {
      test.setTimeout(90_000);
      await signInAsFreshOwner(page, vp.name);
      const voice = recordVoice(page);
      const alerts: string[] = [];
      page.on('console', (msg) => {
        if (msg.type() === 'error' && /Uncaught|TypeError/.test(msg.text())) alerts.push(msg.text());
      });

      await page.goto('/onboarding');
      await expect(page.getByRole('heading', { level: 1, name: 'What should I answer as?' })).toBeVisible();
      await page.getByLabel('Business name').fill('Walsh Plumbing');
      await page.getByRole('button', { name: 'Plumbing' }).click();
      await page.getByLabel('Your cell').fill('(216) 555-0142');
      // Ready's own line, and the first turn fetched one turn ahead while Ready is on screen.
      const firstTurn = page.waitForRequest((r) => r.url().endsWith('/api/voice/tts/batch'));
      await page.getByRole('button', { name: 'Show me my shop' }).click();
      await expect(page.getByRole('heading', { level: 1, name: 'Walsh Plumbing is already set up.' })).toBeVisible();
      await firstTurn;
      await expect.poll(() => voice.find((c) => c.path === '/api/voice/tts')?.items).toEqual(['Walsh Plumbing is already set up.']);
      expect(batches(voice).map((c) => c.items[0])).toEqual([QUESTIONS[0]]);

      await page.getByRole('button', { name: 'Make it mine, 7 choices' }).click();
      for (let i = 0; i < QUESTIONS.length; i += 1) {
        await expect(page.getByRole('heading', { level: 1, name: QUESTIONS[i] })).toBeVisible();
        if (i === 0) {
          // The greeting tells the owner a tap plays the option. Nothing listens in this keyless lane
          // (the browser refuses the microphone), so the line never says to say "first" or "second".
          await expect(page.getByText('Tap one to hear it.', { exact: true })).toBeVisible();
          await expect(page.getByText(/say "first"/i)).toHaveCount(0);
          await expect(page.getByRole('button', { name: 'Answer out loud' })).toHaveCount(0);
        }
        // Whatever the voice route answered, the turn is all there: two cards, Next, no alert.
        await expect(page.getByRole('radio')).toHaveCount(2);
        await expect(page.getByRole('alert')).toHaveCount(0);
        await expectScreenFits(page);
        // The next turn is asked for while this one is up, and never the one after it.
        if (i + 1 < QUESTIONS.length) {
          await expect.poll(() => batches(voice).map((c) => c.items[0])).toEqual(QUESTIONS.slice(0, i + 2));
        }

        const card = page.getByRole('radio').first();
        await card.click();
        await expect(card).toHaveAttribute('aria-checked', 'true');
        const saved = page.waitForResponse((r) => r.url().includes('/api/onboarding/draft/choices/') && r.request().method() === 'PUT');
        await page.getByRole('button', { name: 'Next', exact: true }).click();
        expect((await saved).status()).toBe(200);
      }

      await expect(page.getByRole('heading', { level: 1, name: READBACK_HEADING })).toBeVisible();
      await expect.poll(() => voice.filter((c) => c.path === '/api/voice/tts').map((c) => c.items[0])).toContain(READBACK_HEADING);

      const turnBatches = batches(voice);
      expect(turnBatches).toHaveLength(7);
      expect(turnBatches.every((c) => c.items.length <= 3)).toBe(true);
      expect(turnBatches.flatMap((c) => c.items)).toHaveLength(21);
      // The real routes answered: with clips where a voice is configured, or "not configured" in this keyless lane.
      await expect.poll(() => voice.every((c) => c.status !== undefined)).toBe(true);
      for (const call of voice) expect([200, 501], `${call.path} answered ${call.status}`).toContain(call.status);
      expect(alerts).toEqual([]);
    });
  });
}

/** Answer What-should-I-answer-as and land on Ready. */
async function startShop(page: Page): Promise<void> {
  await page.goto('/onboarding');
  await expect(page.getByRole('heading', { level: 1, name: 'What should I answer as?' })).toBeVisible();
  await page.getByLabel('Business name').fill('Walsh Plumbing');
  await page.getByRole('button', { name: 'Plumbing' }).click();
  await page.getByLabel('Your cell').fill('(216) 555-0142');
  await page.getByRole('button', { name: 'Show me my shop' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Walsh Plumbing is already set up.' })).toBeVisible();
}

/** Every request the shell makes for a live-transcription token, with the real API's answer. */
function recordTokenMints(page: Page): Array<{ status?: number }> {
  const mints: Array<{ status?: number }> = [];
  const byRequest = new Map<Request, { status?: number }>();
  page.on('request', (req) => {
    if (!new URL(req.url()).pathname.startsWith('/api/voice/stream-token')) return;
    const mint = {};
    mints.push(mint);
    byRequest.set(req, mint);
  });
  page.on('response', (res) => {
    const mint = byRequest.get(res.request());
    if (mint) mint.status = res.status();
  });
  return mints;
}

async function answerEveryTurnByTap(page: Page): Promise<void> {
  for (let i = 0; i < QUESTIONS.length; i += 1) {
    await expect(page.getByRole('heading', { level: 1, name: QUESTIONS[i] })).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Answer out loud' })).toHaveCount(0);
    if (i === 0) await expect(page.getByText('Tap one to hear it.', { exact: true })).toBeVisible();
    await expectScreenFits(page);
    await page.getByRole('radio').first().click();
    const saved = page.waitForResponse((r) => r.url().includes('/api/onboarding/draft/choices/') && r.request().method() === 'PUT');
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    expect((await saved).status()).toBe(200);
  }
  await expect(page.getByRole('heading', { level: 1, name: READBACK_HEADING })).toBeVisible();
}

test.describe('v3 listening, where nothing can listen (S3-5) at 320x568', () => {
  test.use({ viewport: { width: 320, height: 568 } });

  test('a refused microphone: no mic, no alert, no token asked for, and all seven turns by tap', async ({ page }) => {
    test.setTimeout(90_000);
    await signInAsFreshOwner(page, 'mic_refused');
    const mints = recordTokenMints(page);
    await startShop(page);
    await expect(page.getByText('Tap the one that sounds right, or say "first" or "second".', { exact: false })).toBeVisible();
    await page.getByRole('button', { name: 'Make it mine, 7 choices' }).click();
    await answerEveryTurnByTap(page);
    expect(mints).toEqual([]);
  });
});

test.describe('v3 listening, microphone granted, no transcription on the server (S3-5) at 320x568', () => {
  // The lane's Chromium runs with a fake microphone device (e2e/onboarding-v3.config.ts); granting the
  // permission is what lets the page open it.
  test.use({ viewport: { width: 320, height: 568 }, permissions: ['microphone'] });

  test('the real token route answers 503, the mic goes away with no alert, and every turn is still a tap', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'The fake microphone device is a Chromium flag');
    test.setTimeout(90_000);
    await signInAsFreshOwner(page, 'no_transcription');
    const mints = recordTokenMints(page);
    await startShop(page);
    await page.getByRole('button', { name: 'Make it mine, 7 choices' }).click();
    await expect(page.getByRole('heading', { level: 1, name: QUESTIONS[0] })).toBeVisible();
    // One mint for the pass: the real route has no key here and says so (503); nothing asks again.
    await expect.poll(() => mints.map((m) => m.status)).toEqual([503]);
    await answerEveryTurnByTap(page);
    expect(mints.map((m) => m.status)).toEqual([503]);
  });
});

