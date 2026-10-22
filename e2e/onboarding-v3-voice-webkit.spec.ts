import { test, expect, type Page, type Request } from '@playwright/test';
import { fakeDeepgram } from './helpers/fake-deepgram';

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
 * narration (the question, each option with why and what callers hear, then
 * which one most shops pick: voice-only onboarding PR 2) goes out as one
 * request of at most four clips, the next turn is asked for while the current
 * one is up and never two ahead, a full pass is 22 clips (the closing line is
 * shared, so it is fetched once);
 * a 429 from the per-user clip budget (a fast pass in a fresh process) never
 * blocks a tap. On WebKit (iOS Safari's engine, project onboarding-v3-webkit,
 * E2E_V3_WEBKIT=1): an owner who reloads on Ready hears nothing until a tap,
 * and the tap unlocks playback. Playwright's WebKit build does not enforce
 * iOS's gesture rule for playback (and on Linux has no MediaRecorder at all),
 * so that test emulates the rule at `play()` — refused until the first pointer
 * or key event on the page — and proves the shell's own behaviour under it.
 * That iOS really refuses, and really records audio/mp4 for the live
 * transcription stream, is a device run (the web verify skill, owner action).
 *
 * Listening (S3-5): whether the browser refuses the microphone (Chromium's
 * --deny-permission-prompts) or grants it (the fake device) and the token route
 * answers 503 (no transcription), the turn has no mic, no alert, the greeting
 * keeps only "Tap one to hear it." (the listening half is never promised where
 * nothing listens), every turn is answered by tap, and the funnel records
 * `answer_mode: 'tap'` once per turn.
 *
 * Scripted speech (voice-only onboarding, build plan PR 1): the lane's API runs
 * with STT_PROVIDER=fixture, so the real token route mints a fixture token, and
 * e2e/helpers/fake-deepgram.ts intercepts the browser's Deepgram socket and
 * plays transcripts back in Deepgram's message shape. Proven: a spoken answer
 * picks the card and moves on (`answer_mode: 'voice'`), and a miss is shown and
 * said aloud; and fifteen everyday and edge answers (ordinals, fillers, prices, card
 * words, a full pass by voice, misses, negation, ambiguity, unfinished words,
 * the same words twice, tap then speak) each save exactly what was meant, or
 * nothing. Questions (build plan PR 3): "what does that mean?", "give me an
 * example", "what do most shops do?" and "say that again" are answered in the
 * transcript card and aloud, save nothing, and the next answer still picks;
 * "what does the first one mean?" is a question, never a pick. That real speech is recognised (audio/mp4 accepted by the stream,
 * the transcript card on a phone) needs a Deepgram key and a microphone: a
 * device run through the web verify skill (owner action).
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

/**
 * iOS Safari's autoplay rule, for an engine that does not apply it: `play()` is refused with
 * NotAllowedError until the owner's first pointer or key event on this page (a reload starts
 * over). Installed after `watchVoiceAndFunnel`, so a refused play never reaches its watcher.
 */
async function requireGestureForPlayback(page: Page): Promise<void> {
  await page.addInitScript(() => {
    let activated = false;
    const activate = () => {
      activated = true;
    };
    for (const type of ['pointerdown', 'mousedown', 'touchstart', 'keydown']) {
      window.addEventListener(type, activate, { capture: true, passive: true });
    }
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function gatedPlay(this: HTMLMediaElement) {
      if (!activated) {
        return Promise.reject(
          new DOMException('The request is not allowed by the user agent or the platform in the current context.', 'NotAllowedError'),
        );
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

    test('Rivet is heard after "Make it mine", every turn is narrated through one request of at most four clips, and all seven are answered by tap', async ({
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
      // The greeting's narration: the question, both greetings with why, then the usual pick.
      expect(batches(voice)[0].items).toEqual([
        QUESTIONS[0],
        expect.stringMatching(/^First: Walsh Plumbing, how can I help\? Short\./),
        expect.stringMatching(/^Second: Thanks for calling Walsh Plumbing\. What's going on today\? A few more words\./),
        'Most shops pick the first. Which one?',
      ]);
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
          // The greeting tells the owner a tap plays the option. Nothing listens here (the microphone is
          // refused), so the line never says to say "first" or "second".
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
      expect(turnBatches.every((c) => c.items.length <= 4)).toBe(true);
      expect(turnBatches.flatMap((c) => c.items)).toHaveLength(22);
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

  test('an owner who reloads on Ready hears nothing until a tap, and the tap unlocks Rivet', { tag: '@webkit' }, async ({ page }) => {
    test.setTimeout(90_000);
    await signInAsFreshOwner(page, 'webkit_reload');
    await watchVoiceAndFunnel(page);
    await requireGestureForPlayback(page);
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

  test('the token route answers 503, the mic goes away with no alert, and every turn is still a tap', { tag: '@chromium' }, async ({ page }) => {
    test.setTimeout(90_000);
    await signInAsFreshOwner(page, 'no_transcription');
    // The lane's API mints fixture tokens (STT_PROVIDER=fixture); this owner's server has no transcription,
    // answered exactly as the route answers with no key (pinned in voice-stream-token.route.test.ts).
    await page.route('**/api/voice/stream-token**', (route) =>
      route.fulfill({ status: 503, json: { error: 'NOT_CONFIGURED', message: 'Live transcription is not configured' } }),
    );
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

test.describe('v3 listening with scripted speech (voice-only onboarding PR 1) at 320x568', () => {
  test.use({ viewport: { width: 320, height: 568 }, permissions: ['microphone'] });

  test('a spoken answer picks the card and moves on; a miss is shown and said aloud', { tag: '@chromium' }, async ({ page }) => {
    test.setTimeout(90_000);
    await signInAsFreshOwner(page, 'scripted_speech');
    await watchVoiceAndFunnel(page);
    const voice = recordVoice(page);
    const mints = recordTokenMints(page);
    const deepgram = await fakeDeepgram(page);
    await startShop(page);
    await page.getByRole('button', { name: 'Make it mine, 7 choices' }).click();

    // The greeting turn listens: the real token route minted (the fixture provider), the socket opened.
    await expect(page.getByRole('heading', { level: 1, name: QUESTIONS[0] })).toBeVisible();
    const mic = page.getByRole('button', { name: 'Answer out loud' });
    await expect(mic).toHaveAttribute('aria-pressed', 'true');
    expect(mints.map((m) => m.status)).toEqual([200]);
    expect(new URL(deepgram.urls[0]).searchParams.getAll('keyterm')).toEqual(expect.arrayContaining(['first', 'second']));
    await expectScreenFits(page);

    // A miss: what was heard and how to answer, on screen and said aloud. Nothing is picked.
    deepgram.say('banana');
    const missLine = 'I heard “banana”. Tap one, or say first or second.';
    await expect(page.getByTestId('rivet-transcript')).toHaveText(missLine);
    await expect.poll(() => voice.filter((c) => c.path === '/api/voice/tts').flatMap((c) => c.items)).toContain(missLine);
    await expect(page.getByRole('radio', { checked: true })).toHaveCount(0);
    await expectScreenFits(page);

    // A spoken answer picks the second card and answers at once.
    const saved = page.waitForResponse((r) => r.url().includes('/api/onboarding/draft/choices/') && r.request().method() === 'PUT');
    deepgram.say('the second one');
    expect((await saved).status()).toBe(200);
    await expect(page.getByRole('heading', { level: 1, name: QUESTIONS[1] })).toBeVisible();

    // The next turn opens its own socket with a fresh token, and "first" answers it.
    await expect(mic).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => deepgram.urls.length).toBe(2);
    // A start cancelled while the answer saved may have minted one more: every mint is the real route's 200.
    expect(mints.length).toBeGreaterThanOrEqual(2);
    expect(mints.every((m) => m.status === 200)).toBe(true);
    const savedSecond = page.waitForResponse((r) => r.url().includes('/api/onboarding/draft/choices/') && r.request().method() === 'PUT');
    deepgram.say('first');
    expect((await savedSecond).status()).toBe(200);
    await expect(page.getByRole('heading', { level: 1, name: QUESTIONS[2] })).toBeVisible();

    const choices = await v3Events(page, 'v3_choice_made');
    expect(choices.map((c) => [c.choice_key, c.answer_mode])).toEqual([
      ['greeting', 'voice'],
      ['trip_fee_and_rate', 'voice'],
    ]);
    await expect(page.getByRole('alert')).toHaveCount(0);
  });
});

/**
 * Fifteen spoken answers an owner really gives, everyday and edge, each in a fresh shop on the real
 * stack with scripted speech. A spoken answer is proven by what was saved (the PUT the real API took),
 * never by the screen alone; a non-answer by nothing being saved.
 */
test.describe('v3 spoken answers, everyday and edge (voice-only onboarding PR 1) at 320x568', () => {
  test.use({ viewport: { width: 320, height: 568 }, permissions: ['microphone'] });

  interface Saved {
    key: string;
    option?: string;
    status?: number;
  }

  /** Every choice the shell saved, with the option it sent and what the API answered. */
  function recordSaves(page: Page): Saved[] {
    const saves: Saved[] = [];
    const byRequest = new Map<Request, Saved>();
    page.on('request', (req) => {
      const m = /\/api\/onboarding\/draft\/choices\/([a-z_]+)$/.exec(new URL(req.url()).pathname);
      if (!m || req.method() !== 'PUT') return;
      const body = (req.postDataJSON() ?? {}) as { choice?: { option?: string } };
      const save: Saved = { key: m[1]!, option: body.choice?.option };
      saves.push(save);
      byRequest.set(req, save);
    });
    page.on('response', (res) => {
      const save = byRequest.get(res.request());
      if (save) save.status = res.status();
    });
    return saves;
  }

  /** A fresh shop on the greeting turn with the mic live and the fake socket open. */
  async function listeningOnGreeting(page: Page, label: string) {
    await signInAsFreshOwner(page, `variation_${label}`);
    await watchVoiceAndFunnel(page);
    const saves = recordSaves(page);
    const deepgram = await fakeDeepgram(page);
    await startShop(page);
    await page.getByRole('button', { name: 'Make it mine, 7 choices' }).click();
    await expect(page.getByRole('heading', { level: 1, name: QUESTIONS[0] })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Answer out loud' })).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => deepgram.urls.length).toBe(1);
    return { saves, deepgram };
  }

  /** Waits for turn `n` (0-based) to be up and listening on its own socket. */
  async function onTurn(page: Page, deepgram: Awaited<ReturnType<typeof fakeDeepgram>>, n: number): Promise<void> {
    await expect(page.getByRole('heading', { level: 1, name: QUESTIONS[n] })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Answer out loud' })).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => deepgram.urls.length).toBeGreaterThanOrEqual(n + 1);
  }

  const saved = (saves: Saved[]) => saves.map((s) => [s.key, s.option]);

  /** Nothing was saved and nothing is picked: the owner is still on `question`, asked again. */
  async function expectNothingPicked(page: Page, saves: Saved[], question: string): Promise<void> {
    // Long enough for a save to have gone out had the shell taken the words as an answer.
    await page.waitForTimeout(1_500);
    expect(saves).toEqual([]);
    await expect(page.getByRole('heading', { level: 1, name: question })).toBeVisible();
    await expect(page.getByRole('radio', { checked: true })).toHaveCount(0);
  }

  const pickCases = [
    { name: '1. "first" picks the first card', says: 'first', option: 'a' },
    { name: '2. "second" picks the second card', says: 'second', option: 'b' },
    { name: '3. "Number two." (capitals and a full stop) picks the second card', says: 'Number two.', option: 'b' },
    { name: '4. "Um, uh, the first one please" (fillers) picks the first card', says: 'Um, uh, the first one please', option: 'a' },
  ] as const;
  for (const c of pickCases) {
    test(c.name, { tag: '@chromium' }, async ({ page }) => {
      test.setTimeout(90_000);
      const { saves, deepgram } = await listeningOnGreeting(page, c.option + c.says.length);
      deepgram.say(c.says);
      await expect.poll(() => saved(saves)).toEqual([['greeting', c.option]]);
      await expect(page.getByRole('heading', { level: 1, name: QUESTIONS[1] })).toBeVisible();
      expect(saves[0]!.status).toBe(200);
      expect((await v3Events(page, 'v3_choice_made')).map((e) => e.answer_mode)).toEqual(['voice']);
    });
  }

  const priceCases = [
    { name: '5. Saying the price, "eighty-nine", picks the $89 card', says: 'eighty-nine', option: 'a' },
    { name: '6. "a hundred and twenty nine dollars" picks the $129 card', says: 'a hundred and twenty nine dollars', option: 'b' },
  ] as const;
  for (const c of priceCases) {
    test(c.name, { tag: '@chromium' }, async ({ page }) => {
      test.setTimeout(90_000);
      const { saves, deepgram } = await listeningOnGreeting(page, `price_${c.option}`);
      deepgram.say('first');
      await onTurn(page, deepgram, 1);
      deepgram.say(c.says);
      await expect.poll(() => saved(saves)).toEqual([
        ['greeting', 'a'],
        ['trip_fee_and_rate', c.option],
      ]);
      await expect(page.getByRole('heading', { level: 1, name: QUESTIONS[2] })).toBeVisible();
    });
  }

  test('7. Words from a card, "hold it for me", pick that card', { tag: '@chromium' }, async ({ page }) => {
    test.setTimeout(90_000);
    const { saves, deepgram } = await listeningOnGreeting(page, 'label');
    deepgram.say('first');
    await onTurn(page, deepgram, 1);
    deepgram.say('first');
    await onTurn(page, deepgram, 2);
    deepgram.say('hold it for me');
    await expect.poll(() => saved(saves).at(-1)).toEqual(['booking_posture', 'b']);
    await expect(page.getByRole('heading', { level: 1, name: QUESTIONS[3] })).toBeVisible();
  });

  test('8. All seven turns answered by voice reach the read-back, every one saved as said', { tag: '@chromium' }, async ({ page }) => {
    test.setTimeout(150_000);
    const { saves, deepgram } = await listeningOnGreeting(page, 'all_seven');
    const answers = ['first', 'second', 'the first one', 'second', 'first', 'the second', 'first'] as const;
    for (let n = 0; n < answers.length; n += 1) {
      await onTurn(page, deepgram, n);
      deepgram.say(answers[n]!);
      await expect.poll(() => saves.length).toBe(n + 1);
    }
    await expect(page.getByRole('heading', { level: 1, name: READBACK_HEADING })).toBeVisible();
    expect(saved(saves)).toEqual(CHOICE_KEYS.map((k, i) => [k, /second/.test(answers[i]!) ? 'b' : 'a']));
    expect(saves.every((s) => s.status === 200)).toBe(true);
    expect((await v3Events(page, 'v3_choice_made')).map((e) => e.answer_mode)).toEqual(CHOICE_KEYS.map(() => 'voice'));
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expectScreenFits(page);
  });

  test('9. Tap, then speak, then tap: each turn records how it was answered', { tag: '@chromium' }, async ({ page }) => {
    test.setTimeout(90_000);
    const { saves, deepgram } = await listeningOnGreeting(page, 'mixed');
    await page.getByRole('radio').nth(1).click();
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await onTurn(page, deepgram, 1);
    deepgram.say('first');
    await expect(page.getByRole('heading', { level: 1, name: QUESTIONS[2] })).toBeVisible();
    await page.getByRole('radio').nth(0).click();
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: QUESTIONS[3] })).toBeVisible();
    expect(saved(saves)).toEqual([
      ['greeting', 'b'],
      ['trip_fee_and_rate', 'a'],
      ['booking_posture', 'a'],
    ]);
    expect((await v3Events(page, 'v3_choice_made')).map((e) => e.answer_mode)).toEqual(['tap', 'voice', 'tap']);
  });

  test('10. Two misses: the second adds an example; then "first" answers and the miss card goes', { tag: '@chromium' }, async ({ page }) => {
    test.setTimeout(90_000);
    const { saves, deepgram } = await listeningOnGreeting(page, 'two_misses');
    const transcript = page.getByTestId('rivet-transcript');
    deepgram.say('banana');
    await expect(transcript).toHaveText('I heard “banana”. Tap one, or say first or second.');
    deepgram.say('purple monkey');
    await expect(transcript).toHaveText(
      'I heard “purple monkey”. Tap one, or say first or second. For example, say “first”, or ask “what does that mean?”',
    );
    expect(saves).toEqual([]);
    deepgram.say('first');
    await expect.poll(() => saved(saves)).toEqual([['greeting', 'a']]);
    await onTurn(page, deepgram, 1);
    await expect(page.getByText(/I heard “/)).toHaveCount(0);
  });

  test('11. "Not the first one" is never taken as the first card', { tag: '@chromium' }, async ({ page }) => {
    test.setTimeout(90_000);
    const { saves, deepgram } = await listeningOnGreeting(page, 'negation');
    deepgram.say('not the first one');
    await expect(page.getByTestId('rivet-transcript')).toContainText('I heard “not the first one”.');
    await expectNothingPicked(page, saves, QUESTIONS[0]);
  });

  test('12. "Either one, first or second" picks neither: no guess is made', { tag: '@chromium' }, async ({ page }) => {
    test.setTimeout(90_000);
    const { saves, deepgram } = await listeningOnGreeting(page, 'ambiguous');
    deepgram.say('either one, first or second');
    await expect(page.getByTestId('rivet-transcript')).toContainText('I heard “either one, first or second”.');
    await expectNothingPicked(page, saves, QUESTIONS[0]);
  });

  test('13. Words heard mid-sentence that never finish ("the sec") answer nothing', { tag: '@chromium' }, async ({ page }) => {
    test.setTimeout(90_000);
    const { saves, deepgram } = await listeningOnGreeting(page, 'interim');
    deepgram.interim('the sec');
    await expectNothingPicked(page, saves, QUESTIONS[0]);
    await expect(page.getByText(/I heard “/)).toHaveCount(0);
  });

  test('14. The same answer heard twice saves once and never answers the next turn', { tag: '@chromium' }, async ({ page }) => {
    test.setTimeout(90_000);
    const { saves, deepgram } = await listeningOnGreeting(page, 'double');
    deepgram.say('first');
    deepgram.say('first');
    await expect(page.getByRole('heading', { level: 1, name: QUESTIONS[1] })).toBeVisible();
    await page.waitForTimeout(1_500);
    expect(saved(saves)).toEqual([['greeting', 'a']]);
    await expect(page.getByRole('radio', { checked: true })).toHaveCount(0);
  });

  test('15. Tapping a card then saying the other one: the spoken answer wins, said once', { tag: '@chromium' }, async ({ page }) => {
    // A tap only selects (and plays what callers hear); Next or a spoken answer is what answers.
    test.setTimeout(90_000);
    const { saves, deepgram } = await listeningOnGreeting(page, 'tap_then_say');
    await page.getByRole('radio').nth(0).click();
    await expect(page.getByRole('radio', { checked: true })).toHaveCount(1);
    expect(saves).toEqual([]);
    deepgram.say('no, the second one');
    await expect.poll(() => saved(saves)).toEqual([['greeting', 'b']]);
    await onTurn(page, deepgram, 1);
    // A late copy of those words on the turn just left answers nothing here.
    deepgram.sayOn(0, 'second');
    await page.waitForTimeout(1_500);
    expect(saved(saves)).toEqual([['greeting', 'b']]);
    expect((await v3Events(page, 'v3_choice_made')).map((e) => e.answer_mode)).toEqual(['voice']);
  });

  // Build plan PR 3: the owner asks Rivet about a choice, out loud. He answers in the card and
  // aloud, asks "Which one?" again, saves nothing, and the next answer still picks.
  // Copy from packages/api/src/onboarding/choices/registry/common.ts.
  const GREETING_EXPLAIN =
    "This is the first thing a caller hears when I pick up your phone. It's in your business's name, so pick the one that sounds like you.";
  const GREETING_EXAMPLE =
    'Someone calls on their lunch break with a problem. The first gets them talking about it right away. The second sounds warmer and takes a breath longer.';

  /** Every line Rivet was asked to say, in the batches the shell sent. */
  function recordSpoken(page: Page): string[] {
    const spoken: string[] = [];
    page.on('request', (req) => {
      if (new URL(req.url()).pathname !== '/api/voice/tts/batch' || req.method() !== 'POST') return;
      spoken.push(...(((req.postDataJSON() ?? {}) as { items?: string[] }).items ?? []));
    });
    return spoken;
  }

  const helpCases = [
    { name: '16. "What does that mean?" is explained, then asked again', says: 'what does that mean', answer: `${GREETING_EXPLAIN} Which one?`, spoken: GREETING_EXPLAIN },
    { name: '17. "Give me an example" tells one real call', says: 'can you give me an example', answer: `${GREETING_EXAMPLE} Which one?`, spoken: GREETING_EXAMPLE },
    {
      name: '18. "What do most shops do?" names the usual pick and why',
      says: 'what do most shops do',
      answer: /^Most shops pick the first: .+, how can I help\? Short\. Gets to the problem fast\. Callers in a hurry like it\. Which one\?$/,
      spoken: 'Most shops pick the first:',
    },
  ] as const;
  for (const c of helpCases) {
    test(c.name, { tag: '@chromium' }, async ({ page }) => {
      test.setTimeout(90_000);
      const spoken = recordSpoken(page);
      const { saves, deepgram } = await listeningOnGreeting(page, `help_${c.says.length}`);
      deepgram.say(c.says);
      await expect(page.getByTestId('rivet-transcript')).toHaveText(c.answer);
      await expect.poll(() => spoken.some((line) => line.startsWith(c.spoken))).toBe(true);
      await expectNothingPicked(page, saves, QUESTIONS[0]);
      // Still listening on the same socket: the answer comes after the question.
      deepgram.say('second');
      await expect.poll(() => saved(saves)).toEqual([['greeting', 'b']]);
      await onTurn(page, deepgram, 1);
    });
  }

  test('19. "Say that again" says the turn again, then "first" answers', { tag: '@chromium' }, async ({ page }) => {
    test.setTimeout(90_000);
    const { saves, deepgram } = await listeningOnGreeting(page, 'repeat');
    const plays = () => page.evaluate(() => (window as unknown as Watched).__audio.plays.length);
    await expect.poll(plays).toBeGreaterThan(0);
    const before = await plays();
    deepgram.say('sorry, can you say that again');
    await expect(page.getByTestId('rivet-transcript')).toHaveText('Saying it again.');
    await expect.poll(plays).toBeGreaterThan(before);
    await expectNothingPicked(page, saves, QUESTIONS[0]);
    deepgram.say('first');
    await expect.poll(() => saved(saves)).toEqual([['greeting', 'a']]);
  });

  test('20. "What does the first one mean?" is a question, not a pick, on a later turn too', { tag: '@chromium' }, async ({ page }) => {
    test.setTimeout(90_000);
    const { saves, deepgram } = await listeningOnGreeting(page, 'question_not_pick');
    deepgram.say('first');
    await onTurn(page, deepgram, 1);
    deepgram.say('first');
    await onTurn(page, deepgram, 2);
    deepgram.say('what does the first one mean');
    await expect(page.getByTestId('rivet-transcript')).toContainText('Booking it means I put the job on your calendar');
    await page.waitForTimeout(1_500);
    expect(saved(saves)).toEqual([
      ['greeting', 'a'],
      ['trip_fee_and_rate', 'a'],
    ]);
    deepgram.say('hold it for me');
    await expect.poll(() => saved(saves).at(-1)).toEqual(['booking_posture', 'b']);
  });
});
