import { test, expect, type Page, type Request } from '@playwright/test';

/**
 * Rivet's voice in the "pick, don't build" onboarding shell (slice S3, plan
 * U4), against the REAL stack (e2e/onboarding-v3.config.ts): the shell asks the
 * API's own voice routes for each turn's lines and the routes answer for real.
 *
 * Speaking (S3-3, S3-6): the lane's API speaks through the dev-only fixture
 * provider (TTS_PROVIDER=fixture, a 200 ms silent mp3 at the vendor boundary),
 * so every route, the clip cache, the per-clip charge and the audit run for
 * real and the browser really plays the clip. Proven: once Ready's line is done
 * the element is paused, and after "Make it mine" an audio/mpeg clip reaches
 * `playing` within 5 s (time to first heard is recorded); each choice turn's
 * lines go out as one request of at most three clips, the next turn is asked
 * for while the current one is up and never two ahead, a full pass is 21 clips;
 * a 429 from the per-user clip budget (a fast pass in a fresh process) never
 * blocks a tap. On WebKit (iOS Safari's engine, project onboarding-v3-webkit,
 * E2E_V3_WEBKIT=1): an owner who reloads on Ready hears nothing until a tap,
 * the tap unlocks playback, and the browser can record audio/mp4 (what the
 * live transcription stream is sent from iOS).
 *
 * Listening (S3-5): the lane has no transcription key, so whether the browser
 * refuses the microphone (Chromium's --deny-permission-prompts) or grants it
 * (the fake device) and the real POST /api/voice/stream-token answers 503, the
 * turn has no mic, no alert, the greeting keeps only "Tap one to hear it." (the
 * listening half is never promised where nothing listens), every turn is
 * answered by tap, and the funnel records `answer_mode: 'tap'` once per turn.
 * A live transcription run (audio/mp4 accepted by the stream, the transcript
 * card on a phone) needs a Deepgram key and a microphone: a device run through
 * the web verify skill (owner action).
 *
 * Browser-specific tests carry a tag the config filters per project, never a
 * run-time skip (scripts/release/verify.mjs fails a run with any skip).
 *
 * Run: QA_CHROMIUM_PATH=... npx playwright test -c e2e/onboarding-v3.config.ts
 *      (add E2E_V3_WEBKIT=1 after `npx playwright install --with-deps webkit`)
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

const apiUrl = process.env.E2E_V3_API_URL ?? 'http://127.0.0.1:3011';

/**
 * Signs the browser in as a new dev owner (its own tenant), so no test sees another's draft or clip budget.
 * The dev auth bypass creates the owner's tenant on its first request; one request before the page opens
 * makes that happen once, instead of racing the page's parallel first requests (which lose on a unique key).
 */
async function signInAsFreshOwner(page: Page, label: string): Promise<void> {
  const token = devOwnerToken(`e2e_v3_voice_${label}_${Date.now()}`);
  const me = await page.request.get(`${apiUrl}/api/me`, { headers: { authorization: `Bearer ${token}` } });
  expect(me.status(), 'the dev owner is created before the page opens').toBe(200);
  await page.route('**/api/**', (route) =>
    route.continue({ headers: { ...route.request().headers(), authorization: `Bearer ${token}` } }),
  );
}

/** Opens onboarding at its first screen. The first page of a run waits on the dev server compiling the app. */
async function openOnboarding(page: Page): Promise<void> {
  await page.goto('/onboarding', { timeout: 90_000 });
  await expect(page.getByRole('heading', { level: 1, name: 'What should I answer as?' })).toBeVisible({ timeout: 30_000 });
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

interface AudioPlay {
  /** performance.now() when the element reported `playing`. */
  at: number;
  /** The start of the source: `data:audio/mpeg` for a clip from the voice routes, `data:audio/wav` for the unlock. */
  src: string;
}

interface Watched {
  __v3Events: Array<{ event: string; props: Record<string, unknown> }>;
  __audio: { plays: AudioPlay[]; elements: HTMLMediaElement[] };
}

/**
 * Before any page script runs: collect the v3 funnel events (the web app pushes onto
 * `window.__v3Events` in a dev build) and watch every audio element the page plays,
 * so the spec sees what the owner would hear. Rivet's element is never in the DOM,
 * so it is caught at `play()`.
 */
async function watchVoiceAndFunnel(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as Watched;
    w.__v3Events = [];
    w.__audio = { plays: [], elements: [] };
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function watchedPlay(this: HTMLMediaElement) {
      if (!w.__audio.elements.includes(this)) {
        w.__audio.elements.push(this);
        this.addEventListener('playing', () => {
          w.__audio.plays.push({ at: performance.now(), src: (this.currentSrc || this.src).slice(0, 15) });
        });
      }
      return play.call(this);
    };
  });
}

const v3Events = (page: Page, event: string) =>
  page.evaluate((name) => (window as unknown as Watched).__v3Events.filter((e) => e.event === name).map((e) => e.props), event);
const audioPlays = (page: Page) => page.evaluate(() => [...(window as unknown as Watched).__audio.plays]);
const everyElementPaused = (page: Page) =>
  page.evaluate(() => (window as unknown as Watched).__audio.elements.every((el) => el.paused));
/** `src.slice(0, 15)` of a clip from the voice routes (the unlock's silent WAV reads `data:audio/wav;`). */
const MPEG = 'data:audio/mpeg';

/** Tap "Make it mine" and require one of the voice routes' clips to start playing within 5 s of the tap. */
async function makeItMineAndHearRivet(page: Page): Promise<void> {
  const before = (await audioPlays(page)).length;
  await page.getByRole('button', { name: 'Make it mine, 7 choices' }).click();
  await expect
    .poll(async () => (await audioPlays(page)).slice(before).some((p) => p.src === MPEG), {
      message: 'a clip from the voice routes reaches `playing` after the tap',
      timeout: 5_000,
    })
    .toBe(true);
}

/** Answer What-should-I-answer-as and land on Ready. */
async function startShop(page: Page): Promise<void> {
  await openOnboarding(page);
  await page.getByLabel('Business name').fill('Walsh Plumbing');
  await page.getByRole('button', { name: 'Plumbing' }).click();
  await page.getByLabel('Your cell').fill('(216) 555-0142');
  await page.getByRole('button', { name: 'Show me my shop' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Walsh Plumbing is already set up.' })).toBeVisible();
}

/** The seven choice keys, in the order Rivet asks them. */
const CHOICE_KEYS = [
  'greeting',
  'trip_fee_and_rate',
  'booking_posture',
  'payment_collection_mode',
  'booking_hours',
  'emergency_target',
  'after_hours_mode',
] as const;

const viewports = [
  { name: '390x844', width: 390, height: 844 },
  { name: '320x568', width: 320, height: 568 },
] as const;

for (const vp of viewports) {
  test.describe(`v3 voice at ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test('Rivet is heard after "Make it mine", every turn speaks through one request of at most three clips, and all seven are answered by tap', async ({
      page,
    }) => {
      test.setTimeout(120_000);
      await signInAsFreshOwner(page, vp.name);
      await watchVoiceAndFunnel(page);
      const voice = recordVoice(page);
      const alerts: string[] = [];
      page.on('console', (msg) => {
        if (msg.type() === 'error' && /Uncaught|TypeError/.test(msg.text())) alerts.push(msg.text());
      });

      await openOnboarding(page);
      // Nothing plays before the owner has tapped anything.
      expect(await audioPlays(page)).toEqual([]);
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
      // Ready's line is said and done: before "Make it mine" the element is paused.
      await expect.poll(() => everyElementPaused(page)).toBe(true);

      await makeItMineAndHearRivet(page);
      await expect.poll(() => v3Events(page, 'v3_first_heard')).toEqual([
        expect.objectContaining({ source: 'server', gesture: 'make_it_mine', ms_since_make_it_mine: expect.any(Number) }),
      ]);

      for (let i = 0; i < QUESTIONS.length; i += 1) {
        // The turn's heading is Rivet's question.
        await expect(page.getByRole('heading', { level: 1, name: QUESTIONS[i] })).toBeVisible();
        if (i === 0) {
          // The greeting tells the owner a tap plays the option. Nothing listens in this keyless lane,
          // so the line never says to say "first" or "second".
          await expect(page.getByText('Tap one to hear it.', { exact: true })).toBeVisible();
          await expect(page.getByText(/say "first"/i)).toHaveCount(0);
        }
        // Whatever the voice route answered, the turn is all there: two cards, Next, no mic, no alert.
        await expect(page.getByRole('radio')).toHaveCount(2);
        await expect(page.getByRole('button', { name: 'Answer out loud' })).toHaveCount(0);
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

      // The read-back reads all seven back, and Rivet is asked to say its heading.
      await expect(page.getByRole('heading', { level: 1, name: READBACK_HEADING })).toBeVisible();
      await expect(page.getByRole('list').getByRole('listitem')).toHaveCount(7);
      await expect.poll(() => voice.filter((c) => c.path === '/api/voice/tts').map((c) => c.items[0])).toContain(READBACK_HEADING);
      await expectScreenFits(page);

      const turnBatches = batches(voice);
      expect(turnBatches).toHaveLength(7);
      expect(turnBatches.every((c) => c.items.length <= 3)).toBe(true);
      expect(turnBatches.flatMap((c) => c.items)).toHaveLength(21);
      // The real routes answered with clips, or with the per-user clip budget's 429 on a fast pass.
      await expect.poll(() => voice.every((c) => c.status !== undefined)).toBe(true);
      for (const call of voice) expect([200, 429], `${call.path} answered ${call.status}`).toContain(call.status);
      expect(voice.filter((c) => c.status === 200).length).toBeGreaterThan(0);

      // The funnel: one tap answer per turn, in order.
      const choices = await v3Events(page, 'v3_choice_made');
      expect(choices.map((c) => c.choice_key)).toEqual([...CHOICE_KEYS]);
      expect(choices.map((c) => c.answer_mode)).toEqual(CHOICE_KEYS.map(() => 'tap'));
      expect(alerts).toEqual([]);
    });
  });
}

test.describe('v3 voice on WebKit (iOS Safari) at 390x844', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('an owner who reloads on Ready hears nothing until a tap, the tap unlocks Rivet, and the browser records audio/mp4', { tag: '@webkit' }, async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await signInAsFreshOwner(page, 'webkit_reload');
    await watchVoiceAndFunnel(page);
    await startShop(page);

    // A returning owner lands on Ready with no tap on this page: Ready's line is refused by autoplay,
    // nothing plays, and the funnel records why.
    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: 'Walsh Plumbing is already set up.' })).toBeVisible();
    await expect.poll(() => v3Events(page, 'v3_tts_fallback')).toEqual([expect.objectContaining({ turn: 'ready', reason: 'autoplay' })]);
    expect((await audioPlays(page)).filter((p) => p.src === MPEG)).toEqual([]);
    expect(await everyElementPaused(page)).toBe(true);

    // The tap unlocks the element and the first question plays on it.
    await makeItMineAndHearRivet(page);
    await expect(page.getByRole('heading', { level: 1, name: QUESTIONS[0] })).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);

    // What iOS sends the live transcription stream; a WebKit that drops it fails the lane.
    expect(await page.evaluate(() => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported('audio/mp4'))).toBe(true);
  });
});

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

  test('a refused microphone: no mic, no alert, no token asked for, and all seven turns by tap', { tag: '@chromium' }, async ({ page }) => {
    test.setTimeout(90_000);
    await signInAsFreshOwner(page, 'mic_refused');
    await watchVoiceAndFunnel(page);
    const mints = recordTokenMints(page);
    await startShop(page);
    await expect(page.getByText('Tap the one that sounds right, or say "first" or "second".', { exact: false })).toBeVisible();
    await page.getByRole('button', { name: 'Make it mine, 7 choices' }).click();
    await answerEveryTurnByTap(page);
    expect(mints).toEqual([]);
    expect(await v3Events(page, 'v3_voice_input')).toEqual([expect.objectContaining({ state: 'denied' })]);
    expect((await v3Events(page, 'v3_choice_made')).map((c) => c.answer_mode)).toEqual(CHOICE_KEYS.map(() => 'tap'));
  });
});

test.describe('v3 listening, microphone granted, no transcription on the server (S3-5) at 320x568', () => {
  // The lane's Chromium runs with a fake microphone device (e2e/onboarding-v3.config.ts); granting the
  // permission is what lets the page open it.
  test.use({ viewport: { width: 320, height: 568 }, permissions: ['microphone'] });

  test('the real token route answers 503, the mic goes away with no alert, and every turn is still a tap', { tag: '@chromium' }, async ({ page }) => {
    test.setTimeout(90_000);
    await signInAsFreshOwner(page, 'no_transcription');
    await watchVoiceAndFunnel(page);
    const mints = recordTokenMints(page);
    await startShop(page);
    await page.getByRole('button', { name: 'Make it mine, 7 choices' }).click();
    await expect(page.getByRole('heading', { level: 1, name: QUESTIONS[0] })).toBeVisible();
    // One mint for the pass: the real route has no key here and says so (503); nothing asks again.
    await expect.poll(() => mints.map((m) => m.status)).toEqual([503]);
    await answerEveryTurnByTap(page);
    expect(mints.map((m) => m.status)).toEqual([503]);
    expect(await v3Events(page, 'v3_voice_input')).toEqual([expect.objectContaining({ state: 'unavailable' })]);
    expect((await v3Events(page, 'v3_choice_made')).map((c) => c.answer_mode)).toEqual(CHOICE_KEYS.map(() => 'tap'));
  });
});
