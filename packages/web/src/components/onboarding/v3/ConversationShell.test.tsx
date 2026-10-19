/**
 * ConversationShell against the real hooks with the network stubbed at `fetch`.
 * The draft is a fixture captured from the API (pinned to the shared contract
 * in __fixtures__), so the screens render what the API really sends. The stub
 * server behaves like the draft routes: PUT /choices/:key is a compare-and-swap
 * on `version` that merges the staged choice and bumps it. The voice routes
 * answer as the API does: by default as a keyless environment (501, so Rivet
 * falls back), or with clips when a test turns the voice on (`tts: 'ok'`).
 */
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import type { OnboardingDraft } from '@ai-service-os/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fullyAnsweredDraft, plumbingCleDraft, withChoices } from './__fixtures__';
import { PLANS, statusAt } from './__fixtures__/after';
import { _resetOnboardingStatusCacheForTests } from '../../../hooks/useOnboardingStatus';
import { expectAllTapTargets } from '../../../test-utils/tap-target';

const track = vi.hoisted(() => ({ trackFunnel: vi.fn(), track: vi.fn() }));
vi.mock('../../../lib/analytics', () => track);
vi.mock('../../../hooks/useUndoableApproval', () => ({ UNDO_WINDOW_MS: 200 }));
vi.mock('../v2/OnboardingShell', () => ({ OnboardingShell: () => <div>v2 shell</div> }));

import { ConversationShell } from './ConversationShell';

const TENANT = '00000000-0000-0000-0000-0000000000a1';
const IDS = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
const draftJson: OnboardingDraft = plumbingCleDraft;
const approvedJson: OnboardingDraft = { ...draftJson, status: 'approved', version: 2, proposalIds: IDS, approvedAt: '2026-10-18T10:05:00.000Z' };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function statusBody(over: Record<string, unknown> = {}) {
  return { steps: [], currentStep: 'identity', isComplete: false, voiceAgentLive: false, tenantId: TENANT, subscriptionStatus: null, ...over };
}

type StageFault = 'error' | 'conflict';
/** How the next creates of the draft go wrong: the API refuses the cell (400 naming `phone`), or something else fails. */
type CreateFault = 'refused_cell' | 'error';

const REFUSED_CELL = 'That does not look like a US cell number. Include the 10-digit area code, for example (216) 555-0100.';

interface Server {
  draft: OnboardingDraft | null;
  status: object;
  /** Forced outcomes for the next staged choices, in order; after that the stub behaves. */
  stageFaults?: StageFault[];
  /** Forced outcomes for the next creates of the draft, in order; after that the stub behaves. */
  createFaults?: CreateFault[];
  /** Make "That's right" fail with a server error. */
  approveFails?: boolean;
  /** Hold the next staged choice until this settles, so a test can act while a save is in flight. */
  stageGate?: Promise<void>;
  /** How the voice routes answer: with clips, or with the API's error for that status. Default 501 (no voice configured). */
  tts?: 'ok' | 429 | 501 | 502;
  /** How POST /api/voice/stream-token answers: a 30 s token, or 503 when transcription is not set up. Default 200. */
  streamToken?: 200 | 503;
}

interface Request {
  method: string;
  path: string;
  body: { choice?: unknown; version?: number; items?: string[]; text?: string } | undefined;
}

const TTS_ERRORS = {
  429: { error: 'RATE_LIMITED', message: 'Too many spoken answers in a row. The answer is still on screen.' },
  501: { error: 'NOT_CONFIGURED', message: 'Speech synthesis is not configured' },
  502: { error: 'TTS_FAILED', message: "Couldn't speak that answer right now — it's still on screen." },
} as const;
const audioOf = (text: string) => btoa(encodeURIComponent(text));
/** What the audio element is given for a line the server spoke. */
const srcFor = (text: string) => `data:audio/mpeg;base64,${audioOf(text)}`;
const clipFor = (text: string, i: number) => ({ clipHash: String(i).padStart(64, '0'), audio: audioOf(text), contentType: 'audio/mpeg', cached: false });

function ttsAnswer(path: string, method: string, body: Request['body']): Response | null {
  if (!path.startsWith('/api/voice/tts')) return null;
  if (method === 'GET') return json(404, { error: 'NOT_CACHED', message: 'That clip is not cached here' });
  const mode = server.tts ?? 501;
  if (mode !== 'ok') return json(mode, TTS_ERRORS[mode]);
  if (path === '/api/voice/tts/batch') return json(200, { clips: body!.items!.map((text, i) => ({ text, ...clipFor(text, i) })) });
  return json(200, clipFor(body!.text!, 0));
}

let server: Server;
let requests: Request[];

const resolved = (r: Response) => Promise.resolve(r);

function stubNetwork(initial: Server) {
  server = { stageFaults: [], ...initial };
  requests = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Request['body']) : undefined;
      requests.push({ method, path, body });
      const tts = ttsAnswer(path, method, body);
      if (tts) return resolved(tts);
      if (path.startsWith('/api/voice/stream-token') && method === 'POST') {
        return resolved(
          (server.streamToken ?? 200) === 200
            ? json(200, { token: 'dg-temp', expiresIn: 30, model: 'nova-3' })
            : json(503, { error: 'NOT_CONFIGURED', message: 'Live transcription is not configured' }),
        );
      }
      if (path === '/api/onboarding/status') return resolved(json(200, server.status));
      if (path === '/api/onboarding/billing/plans') return resolved(json(200, { plans: PLANS }));
      if (path === '/api/onboarding/draft' && method === 'GET') {
        return resolved(
          server.draft ? json(200, { draft: server.draft }) : json(404, { error: 'NOT_FOUND', message: 'OnboardingDraft not found' }),
        );
      }
      if (path === '/api/onboarding/draft' && method === 'POST') {
        const fault = server.createFaults?.shift();
        if (fault === 'error') return resolved(json(500, { error: 'INTERNAL', message: 'boom' }));
        if (fault === 'refused_cell') {
          return resolved(
            json(400, { error: 'VALIDATION_ERROR', message: 'Validation failed', details: { issues: [{ path: 'phone', message: REFUSED_CELL }] } }),
          );
        }
        server.draft = server.draft ?? draftJson;
        return resolved(json(201, { draft: server.draft, created: true }));
      }
      if (path.startsWith('/api/onboarding/draft/choices/') && method === 'PUT') {
        const gate = server.stageGate;
        server.stageGate = undefined;
        const respond = (): Response => {
          const key = path.slice(path.lastIndexOf('/') + 1);
          const current = server.draft!;
          const fault = server.stageFaults?.shift();
          if (fault === 'error') return json(500, { error: 'INTERNAL', message: 'boom' });
          if (fault === 'conflict') {
            // Another tab got there first: the draft moves on, and this write is stale.
            server.draft = withChoices(current, { after_hours_mode: { option: 'b' } });
            return json(409, { error: 'CONFLICT', message: `VERSION_CONFLICT: expected ${body?.version}, found ${server.draft.version}; re-read the draft` });
          }
          if (body?.version !== current.version) {
            return json(409, { error: 'CONFLICT', message: `VERSION_CONFLICT: expected ${body?.version}, found ${current.version}; re-read the draft` });
          }
          server.draft = { ...withChoices(current, { [key]: body.choice as never }), version: current.version + 1 };
          return json(200, { draft: server.draft });
        };
        return gate ? gate.then(respond) : resolved(respond());
      }
      if (path === '/api/onboarding/draft/approve' && method === 'POST') {
        if (server.approveFails) return resolved(json(500, { error: 'INTERNAL', message: 'boom' }));
        const base = server.draft ?? draftJson;
        server.draft = { ...base, status: 'approved', version: base.version + 1, proposalIds: IDS, approvedAt: '2026-10-18T10:05:00.000Z' };
        return resolved(json(200, { draft: server.draft, proposalIds: IDS, approvedNow: true }));
      }
      throw new Error(`unexpected request ${method} ${path}`);
    }),
  );
}

function renderShell(url = '/onboarding') {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/onboarding" element={<ConversationShell />} />
        <Route path="/" element={<div>home page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

/** The audio element: jsdom plays nothing, so play() records the clip and the test fires the element's own events. */
let played: string[];
const play = vi.fn(function (this: HTMLMediaElement) {
  played.push(this.src);
  queueMicrotask(() => this.dispatchEvent(new Event('playing')));
  return Promise.resolve();
});
const audio = () => play.mock.contexts.at(-1) as HTMLMediaElement;
const ttsBatches = () => requests.filter((r) => r.path === '/api/voice/tts/batch').map((r) => r.body?.items ?? []);
const ttsPosts = () => requests.filter((r) => r.path.startsWith('/api/voice/tts') && r.method === 'POST');

const draftCalls = () => requests.filter((r) => r.path.startsWith('/api/onboarding/draft')).map((r) => `${r.method} ${r.path}`);
const stagedCalls = () => requests.filter((r) => r.method === 'PUT');
const funnel = (event: string) => track.trackFunnel.mock.calls.filter(([e]) => e === event).map(([, , extra]) => extra);
const progress = () => screen.getByRole('progressbar', { name: 'Setup progress' }).getAttribute('aria-valuenow');

/** The seven turns: Rivet's question, then the label of each option. */
const TURNS = [
  { key: 'greeting', question: 'How should I answer your phone?', a: 'Walsh Plumbing, how can I help?', b: "Thanks for calling Walsh Plumbing. What's going on today?" },
  { key: 'trip_fee_and_rate', question: 'What do you charge to come out?', a: '$89 to come out, then $150 an hour', b: '$129 to come out, then $185 an hour' },
  { key: 'booking_posture', question: 'When someone wants a repair, do I book it or hold it for you?', a: 'Book it on the call', b: 'Hold it for me' },
  { key: 'payment_collection_mode', question: "When a job's done, how do you want to get paid?", a: 'Text them a pay link', b: 'Collect on the spot' },
  { key: 'booking_hours', question: 'When should I put jobs on your calendar?', a: 'Monday to Saturday, 7 to 5', b: 'Weekdays, 7 to 5' },
  { key: 'emergency_target', question: 'Who do I ring first when it is an emergency?', a: 'Your cell, every time', b: "Your cell, then text you if you don't pick up" },
  { key: 'after_hours_mode', question: 'Same call at 9pm. Do I answer and book, or take a message?', a: 'Answer and book, any hour', b: 'Take a message after hours' },
] as const;

const turn = (i: number) => TURNS[i];
const onTurn = (i: number) => screen.findByRole('heading', { level: 1, name: turn(i).question });
const READBACK = { level: 1, name: "Here's what I've got. Tap anything to change it." } as const;

async function choose(label: string, button: 'Next' | 'Save' = 'Next') {
  await userEvent.click(screen.getByRole('radio', { name: label }));
  await userEvent.click(screen.getByRole('button', { name: button }));
}

async function makeItMine() {
  await userEvent.click(await screen.findByRole('button', { name: 'Make it mine, 7 choices' }));
}

describe('ConversationShell', () => {
  beforeEach(() => {
    _resetOnboardingStatusCacheForTests();
    track.trackFunnel.mockClear();
    played = [];
    play.mockClear();
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(play as unknown as () => Promise<void>);
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    try {
      sessionStorage.clear();
    } catch {
      /* no storage */
    }
  });
  afterEach(() => {
    // Unmount first, while play/pause are still stubbed: unmounting stops Rivet, which pauses the element.
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('opens on the finished shop when a draft exists, with the header and progress line', async () => {
    stubNetwork({ draft: draftJson, status: statusBody() });
    renderShell();

    expect(await screen.findByRole('heading', { level: 1, name: 'Walsh Plumbing is already set up.' })).toBeInTheDocument();
    expect(screen.getByText('About 6 minutes left')).toBeInTheDocument();
    expect(progress()).toBe('15');
    expect(screen.getByText('Nothing saved yet')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Keep the rest as is' })).not.toBeInTheDocument();
    expect(draftCalls()).toEqual(['GET /api/onboarding/draft']);
    await waitFor(() =>
      expect(track.trackFunnel).toHaveBeenCalledWith(
        'v3_ready_viewed',
        expect.objectContaining({ tenantId: TENANT }),
        expect.objectContaining({ trade: 'plumbing', metro: 'CLE' }),
      ),
    );
  });

  describe('the seven turns', () => {
    it('walks all seven in registry order and ends at the read-back with what was picked', async () => {
      stubNetwork({ draft: draftJson, status: statusBody() });
      renderShell();
      await makeItMine();

      // Turn 1: Rivet's own words, both options, the typical one marked, nothing selected, Next waiting.
      expect(await onTurn(0)).toBeInTheDocument();
      // Rivet speaks: tapping an option plays it. This browser cannot listen (jsdom has no microphone),
      // so the line keeps only its hearing half; "Rivet listens" below has the whole line.
      expect(screen.getByText('Tap one to hear it.')).toBeInTheDocument();
      expect(screen.queryByText(/say "first"|say "second"/i)).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Answer out loud' })).not.toBeInTheDocument();
      expect(screen.getAllByRole('radio')).toHaveLength(2);
      expect(screen.getAllByText('Most shops like yours')).toHaveLength(1);
      expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
      expect(screen.getByText('Nothing saved yet')).toBeInTheDocument();
      expect(screen.getByText('About 6 minutes left')).toBeInTheDocument();
      expect(progress()).toBe('15');

      await choose(turn(0).b);
      expect(await onTurn(1)).toBeInTheDocument();
      expect(progress()).toBe('20');
      expect(screen.getByText('About 5 minutes left')).toBeInTheDocument();

      // The price turn takes dollars: typed, parsed to integer cents.
      await userEvent.click(screen.getByRole('button', { name: 'Type instead' }));
      await userEvent.type(screen.getByRole('textbox', { name: 'To come out' }), '$120');
      await userEvent.type(screen.getByRole('textbox', { name: 'Per hour' }), '175');
      await userEvent.click(screen.getByRole('button', { name: 'Next' }));

      expect(await onTurn(2)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Type instead' })).not.toBeInTheDocument();
      await choose(turn(2).b);
      expect(await onTurn(3)).toBeInTheDocument();
      await choose(turn(3).a);
      expect(await onTurn(4)).toBeInTheDocument();
      await choose(turn(4).b);
      expect(await onTurn(5)).toBeInTheDocument();
      await choose(turn(5).a);
      expect(await onTurn(6)).toBeInTheDocument();
      expect(progress()).toBe('45');
      expect(screen.getByText('About 3 minutes left')).toBeInTheDocument();
      await choose(turn(6).b);

      // The read-back: seven rows, with the owner's own answers.
      expect(await screen.findByRole('heading', READBACK)).toBeInTheDocument();
      expect(progress()).toBe('50');
      expect(screen.getByText('Waiting for your OK')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Keep the rest as is' })).not.toBeInTheDocument();
      const list = screen.getByRole('list');
      expect(within(list).getAllByRole('listitem')).toHaveLength(7);
      expect(within(list).getByText(turn(0).b)).toBeInTheDocument();
      expect(within(list).getByText('$120 to come out, $175 an hour after')).toBeInTheDocument();
      expect(within(list).queryByText(/Typical for/)).not.toBeInTheDocument();
      expect(within(list).getByText(turn(2).b)).toBeInTheDocument();
      expect(within(list).getByText(turn(3).a)).toBeInTheDocument();
      expect(within(list).getByText(turn(4).b)).toBeInTheDocument();
      expect(within(list).getByText(turn(5).a)).toBeInTheDocument();
      expect(within(list).getByText(turn(6).b)).toBeInTheDocument();
      expect(draftCalls()).not.toContain('POST /api/onboarding/draft/approve');
    });

    it('stages each answer once, in order, carrying the version the last one returned', async () => {
      stubNetwork({ draft: draftJson, status: statusBody() });
      renderShell();
      await makeItMine();
      await onTurn(0);
      await choose(turn(0).b);
      await onTurn(1);
      await userEvent.click(screen.getByRole('button', { name: 'Type instead' }));
      await userEvent.type(screen.getByRole('textbox', { name: 'To come out' }), '89.50');
      await userEvent.type(screen.getByRole('textbox', { name: 'Per hour' }), '$175');
      await userEvent.click(screen.getByRole('button', { name: 'Next' }));
      await onTurn(2);
      await choose(turn(2).a);
      await onTurn(3);

      expect(stagedCalls().map((r) => [r.path, r.body])).toEqual([
        ['/api/onboarding/draft/choices/greeting', { choice: { option: 'b' }, version: 1 }],
        [
          '/api/onboarding/draft/choices/trip_fee_and_rate',
          {
            choice: {
              override: {
                label: '$89.50 to come out, then $175 an hour',
                writes: {},
                prices: { tripFeeCents: 8950, hourlyRateCents: 17500 },
              },
            },
            version: 2,
          },
        ],
        ['/api/onboarding/draft/choices/booking_posture', { choice: { option: 'a' }, version: 3 }],
      ]);
    });

    it('answers the greeting by typing, staging the owner’s words as the override', async () => {
      stubNetwork({ draft: draftJson, status: statusBody() });
      renderShell();
      await makeItMine();
      await onTurn(0);
      await userEvent.click(screen.getByRole('button', { name: 'Type instead' }));
      await userEvent.type(screen.getByRole('textbox', { name: 'Your greeting' }), 'Walsh here, go ahead');
      await userEvent.click(screen.getByRole('button', { name: 'Next' }));
      await onTurn(1);
      expect(stagedCalls()[0].body).toEqual({
        choice: { override: { label: 'Walsh here, go ahead', writes: { voiceGreeting: 'Walsh here, go ahead' } } },
        version: 1,
      });
    });

    it('keeps the owner on a typed turn, with the inline message, until the dollars parse', async () => {
      stubNetwork({ draft: draftJson, status: statusBody() });
      renderShell();
      await makeItMine();
      await onTurn(0);
      await choose(turn(0).a);
      await onTurn(1);
      await userEvent.click(screen.getByRole('button', { name: 'Type instead' }));
      await userEvent.type(screen.getByRole('textbox', { name: 'To come out' }), 'cheap');
      await userEvent.type(screen.getByRole('textbox', { name: 'Per hour' }), '150');
      await userEvent.click(screen.getByRole('button', { name: 'Next' }));
      expect(screen.getByRole('alert')).toHaveTextContent('Use dollars, like 120 or 89.50.');
      expect(await onTurn(1)).toBeInTheDocument();
      expect(stagedCalls()).toHaveLength(1);
    });

    it('records the funnel: each turn viewed once, each choice with how it was made, never the typed words or prices', async () => {
      stubNetwork({ draft: draftJson, status: statusBody() });
      renderShell();
      await makeItMine();
      await onTurn(0);
      await choose(turn(0).b); // not the typical option
      await onTurn(1);
      await userEvent.click(screen.getByRole('button', { name: 'Type instead' }));
      await userEvent.type(screen.getByRole('textbox', { name: 'To come out' }), '120');
      await userEvent.type(screen.getByRole('textbox', { name: 'Per hour' }), '175');
      await userEvent.click(screen.getByRole('button', { name: 'Next' }));
      await onTurn(2);
      await choose(turn(2).a); // the typical option
      await onTurn(3);

      expect(funnel('v3_turn_viewed')).toEqual([
        { choice_key: 'greeting' },
        { choice_key: 'trip_fee_and_rate' },
        { choice_key: 'booking_posture' },
        { choice_key: 'payment_collection_mode' },
      ]);
      expect(funnel('v3_choice_made')).toEqual([
        { choice_key: 'greeting', answer_mode: 'tap', option: 'b', is_most_shops: false },
        { choice_key: 'trip_fee_and_rate', answer_mode: 'type', option: 'override', is_most_shops: false },
        { choice_key: 'booking_posture', answer_mode: 'tap', option: 'a', is_most_shops: true },
      ]);
      for (const event of ['v3_turn_viewed', 'v3_choice_made']) {
        expect(track.trackFunnel).toHaveBeenCalledWith(event, expect.objectContaining({ tenantId: TENANT }), expect.anything());
      }
      const everything = JSON.stringify(track.trackFunnel.mock.calls);
      for (const leaked of ['120', '175', '12000', '17500', 'to come out']) expect(everything).not.toContain(leaked);
    });

    it('does not record a choice, or move on, when saving it failed', async () => {
      stubNetwork({ draft: draftJson, status: statusBody(), stageFaults: ['error'] });
      renderShell();
      await makeItMine();
      await onTurn(0);
      await choose(turn(0).b);

      expect(await screen.findByRole('alert')).toHaveTextContent("That didn't go through. Try again.");
      expect(screen.getByRole('heading', { level: 1, name: turn(0).question })).toBeInTheDocument();
      expect(funnel('v3_choice_made')).toEqual([]);
      // The pick is still there to tap Next on again.
      expect(screen.getByRole('radio', { name: turn(0).b })).toHaveAttribute('aria-checked', 'true');
      await userEvent.click(screen.getByRole('button', { name: 'Next' }));
      expect(await onTurn(1)).toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(funnel('v3_choice_made')).toHaveLength(1);
    });

    it('does not carry a failed answer over to the read-back when the owner skips ahead', async () => {
      stubNetwork({ draft: draftJson, status: statusBody(), stageFaults: ['error'] });
      renderShell();
      await makeItMine();
      await onTurn(0);
      await choose(turn(0).b);
      expect(await screen.findByRole('alert')).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'Keep the rest as is' }));
      expect(await screen.findByRole('heading', READBACK)).toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });

    it('stays on the turn, with a one-line notice, when the draft changed somewhere else', async () => {
      stubNetwork({ draft: draftJson, status: statusBody(), stageFaults: ['conflict'] });
      renderShell();
      await makeItMine();
      await onTurn(0);
      await choose(turn(0).b);

      expect(await screen.findByRole('status')).toHaveTextContent('Your answers changed somewhere else, so I refreshed them. Tap again.');
      expect(screen.getByRole('heading', { level: 1, name: turn(0).question })).toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(funnel('v3_choice_made')).toEqual([]);

      // Tap again: it goes through on the refreshed version.
      await userEvent.click(screen.getByRole('button', { name: 'Next' }));
      expect(await onTurn(1)).toBeInTheDocument();
      expect(stagedCalls().map((r) => r.body?.version)).toEqual([1, 2]);
    });

    it('does not offer a second tap while an answer is being saved', async () => {
      stubNetwork({ draft: draftJson, status: statusBody() });
      renderShell();
      await makeItMine();
      await onTurn(0);
      await userEvent.click(screen.getByRole('radio', { name: turn(0).a }));
      const next = screen.getByRole('button', { name: 'Next' });
      await userEvent.dblClick(next);
      await onTurn(1);
      expect(stagedCalls().filter((r) => r.path.endsWith('/greeting'))).toHaveLength(1);
    });
  });

  describe('Rivet speaks', () => {
    const lines = (i: number) => {
      const t = draftJson.assembled.choices.find((c) => c.settingKey === turn(i).key)!;
      return [t.question, t.options[0].rivetLine, t.options[1].rivetLine];
    };

    it('the "Make it mine" tap plays the audio inside the tap, then the first question is spoken in the server voice', async () => {
      stubNetwork({ draft: draftJson, status: statusBody(), tts: 'ok' });
      renderShell();
      const button = await screen.findByRole('button', { name: 'Make it mine, 7 choices' });
      play.mockClear();
      button.click();
      // Same task as the tap: the element is unlocked before anything is awaited.
      expect(play).toHaveBeenCalled();
      await onTurn(0);
      await waitFor(() => expect(played).toContain(srcFor(turn(0).question)));
      // The turn's three lines came in one request (fetched while Ready was on screen).
      expect(ttsBatches()).toContainEqual(lines(0));
      await waitFor(() =>
        expect(track.trackFunnel).toHaveBeenCalledWith(
          'v3_first_heard',
          expect.objectContaining({ tenantId: TENANT }),
          expect.objectContaining({ source: 'server', gesture: 'make_it_mine', ms_since_make_it_mine: expect.any(Number) }),
        ),
      );
    });

    it('shows that Rivet is speaking, in words, while a line plays', async () => {
      stubNetwork({ draft: draftJson, status: statusBody(), tts: 'ok' });
      renderShell();
      await makeItMine();
      await onTurn(0);
      await waitFor(() => expect(played.at(-1)).toBe(srcFor(turn(0).question)));
      expect(await screen.findByText('Speaking')).toBeInTheDocument();
      act(() => {
        audio().dispatchEvent(new Event('ended'));
      });
      await waitFor(() => expect(screen.queryByText('Speaking')).not.toBeInTheDocument());
    });

    it('tapping an option plays what Rivet would say, from the turn already fetched', async () => {
      stubNetwork({ draft: draftJson, status: statusBody(), tts: 'ok' });
      renderShell();
      await makeItMine();
      await onTurn(0);
      await choose(turn(0).a);
      await onTurn(1);
      await userEvent.click(screen.getByRole('radio', { name: turn(1).a }));
      await userEvent.click(screen.getByRole('button', { name: 'Next' }));
      await onTurn(2);
      await waitFor(() => expect(played.at(-1)).toBe(srcFor(turn(2).question)));
      const before = ttsPosts().length;
      await userEvent.click(screen.getByRole('radio', { name: turn(2).b }));
      await waitFor(() => expect(played.at(-1)).toBe(srcFor(lines(2)[2])));
      expect(screen.getByRole('radio', { name: turn(2).b })).toHaveAttribute('aria-checked', 'true');
      expect(ttsPosts().length).toBe(before);
    });

    it('counts the clips of a full pass: one request a turn, at most three clips each, never two turns ahead', async () => {
      stubNetwork({ draft: draftJson, status: statusBody(), tts: 'ok' });
      renderShell();
      await makeItMine();
      for (let i = 0; i < TURNS.length; i += 1) {
        await onTurn(i);
        await waitFor(() => expect(played).toContain(srcFor(turn(i).question)));
        // Fetched so far: this turn and at most the next one.
        const asked = ttsBatches().map((items) => items[0]);
        expect(asked.every((q) => TURNS.slice(0, i + 2).some((t) => t.question === q))).toBe(true);
        if (i === 1) {
          await userEvent.click(screen.getByRole('radio', { name: turn(1).a }));
          await userEvent.click(screen.getByRole('button', { name: 'Next' }));
        } else {
          await choose(turn(i).a);
        }
      }
      expect(await screen.findByRole('heading', READBACK)).toBeInTheDocument();
      const batches = ttsBatches();
      expect(batches).toEqual(TURNS.map((_, i) => lines(i)));
      expect(batches.every((items) => items.length <= 3)).toBe(true);
      expect(batches.flat()).toHaveLength(21);
    });

    it.each([429, 501, 502] as const)('a %s from the voice routes still leaves every turn answerable by tap, with no alert', async (status) => {
      stubNetwork({ draft: draftJson, status: statusBody(), tts: status });
      renderShell();
      await makeItMine();
      await onTurn(0);
      expect(screen.getAllByRole('radio')).toHaveLength(2);
      expect(screen.getByRole('button', { name: 'Next' })).toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      await choose(turn(0).a);
      await onTurn(1);
      const reason = { 429: 'rate_limited', 501: 'not_configured', 502: 'tts_failed' }[status];
      await waitFor(() => expect(funnel('v3_tts_fallback')).toContainEqual({ reason, mode: 'silent', turn: 'greeting' }));
      expect(played).not.toContain(srcFor(turn(0).question));
    });

    it('"Looks right as is" unlocks the audio too, and Rivet reads the read-back heading', async () => {
      stubNetwork({ draft: draftJson, status: statusBody(), tts: 'ok' });
      renderShell();
      const keep = await screen.findByRole('button', { name: 'Looks right as is, skip the choices' });
      play.mockClear();
      keep.click();
      expect(play).toHaveBeenCalled();
      expect(await screen.findByRole('heading', READBACK)).toBeInTheDocument();
      await waitFor(() => expect(played.at(-1)).toBe(srcFor(READBACK.name)));
      expect(ttsPosts().find((r) => r.body?.text === READBACK.name)?.path).toBe('/api/voice/tts');
    });
  });

  describe('Rivet listens (S3-5)', () => {
    // The microphone and Deepgram's socket are the browser/vendor boundary, faked as in
    // useDeepgramDictation.test.ts; the shell, its hooks, the matcher and the stage path are real.
    class FakeWebSocket {
      static OPEN = 1;
      static instances: FakeWebSocket[] = [];
      readyState = 0;
      onopen: (() => void) | null = null;
      onmessage: ((e: { data: string }) => void) | null = null;
      onerror: (() => void) | null = null;
      onclose: (() => void) | null = null;
      constructor(readonly url: string) {
        FakeWebSocket.instances.push(this);
      }
      send() {}
      close() {
        this.readyState = 3;
      }
    }
    class FakeMediaRecorder {
      state = 'inactive';
      ondataavailable: unknown = null;
      start() {
        this.state = 'recording';
      }
      stop() {
        this.state = 'inactive';
      }
    }
    let micRefused: boolean;
    const getUserMedia = vi.fn(async () => {
      if (micRefused) throw new DOMException('Permission denied', 'NotAllowedError');
      return { getTracks: () => [{ stop: vi.fn() }] };
    });

    beforeEach(() => {
      FakeWebSocket.instances = [];
      micRefused = false;
      getUserMedia.mockClear();
      vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);
      vi.stubGlobal('MediaRecorder', FakeMediaRecorder as unknown as typeof MediaRecorder);
      vi.stubGlobal('navigator', { ...navigator, mediaDevices: { getUserMedia } });
    });

    /** The turn's socket opens (Deepgram accepted the token). */
    async function socketOpens() {
      await waitFor(() => expect(FakeWebSocket.instances.at(-1)?.onopen).toBeTruthy());
      act(() => {
        const ws = FakeWebSocket.instances.at(-1)!;
        ws.readyState = 1;
        ws.onopen?.();
      });
    }
    function ownerSays(transcript: string) {
      act(() => {
        FakeWebSocket.instances
          .at(-1)!
          .onmessage?.({ data: JSON.stringify({ is_final: true, speech_final: true, channel: { alternatives: [{ transcript }] } }) });
      });
    }

    it('asks the greeting with the whole line, and a spoken "the second one" saves through the same call as a tap', async () => {
      stubNetwork({ draft: draftJson, status: statusBody() });
      renderShell();
      await makeItMine();
      await onTurn(0);
      expect(getUserMedia).toHaveBeenCalledTimes(1);
      expect(screen.getByText('Tap one to hear it. Say "first" or "second" to pick.')).toBeInTheDocument();
      await socketOpens();
      expect(screen.getByRole('button', { name: 'Answer out loud' })).toHaveAttribute('aria-pressed', 'true');

      ownerSays('the second one');
      expect(await onTurn(1)).toBeInTheDocument();
      expect(stagedCalls().map((r) => [r.path, r.body])).toEqual([
        ['/api/onboarding/draft/choices/greeting', { choice: { option: 'b' }, version: 1 }],
      ]);
      expect(funnel('v3_choice_made')).toEqual([{ choice_key: 'greeting', answer_mode: 'voice', option: 'b', is_most_shops: false }]);
      // The transcript never reaches the funnel.
      expect(JSON.stringify(track.trackFunnel.mock.calls)).not.toContain('second one');
      // The next turn listens on its own socket, on the same microphone.
      await socketOpens();
      expect(FakeWebSocket.instances).toHaveLength(2);
      expect(getUserMedia).toHaveBeenCalledTimes(1);
    });

    it('shows "Heard" under the card it picked while the answer is being saved', async () => {
      let release!: () => void;
      stubNetwork({ draft: draftJson, status: statusBody(), stageGate: new Promise<void>((r) => (release = r)) });
      renderShell();
      await makeItMine();
      await onTurn(0);
      await socketOpens();
      ownerSays('the first one');
      const picked = screen.getByRole('radio', { name: turn(0).a });
      expect(picked).toHaveAttribute('aria-checked', 'true');
      expect(within(picked).getByText('Heard: “the first one”')).toBeInTheDocument();
      release();
      expect(await onTurn(1)).toBeInTheDocument();
      expect(funnel('v3_choice_made')).toHaveLength(1);
    });

    it('with the microphone refused, every turn is still answered by tap, with no alert and no mic', async () => {
      micRefused = true;
      stubNetwork({ draft: draftJson, status: statusBody() });
      renderShell();
      await makeItMine();
      for (let i = 0; i < TURNS.length; i += 1) {
        expect(await onTurn(i)).toBeInTheDocument();
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Answer out loud' })).not.toBeInTheDocument();
        if (i === 0) {
          expect(screen.getByText('Tap one to hear it.')).toBeInTheDocument();
          expect(screen.queryByText(/say "first"/i)).not.toBeInTheDocument();
        }
        await choose(turn(i).a);
      }
      expect(await screen.findByRole('heading', READBACK)).toBeInTheDocument();
      expect(funnel('v3_choice_made').map((e) => (e as { answer_mode: string }).answer_mode)).toEqual(Array(7).fill('tap'));
      expect(funnel('v3_voice_input')).toEqual([{ state: 'denied' }]);
      expect(requests.filter((r) => r.path.startsWith('/api/voice/stream-token'))).toEqual([]);
      expect(getUserMedia).toHaveBeenCalledTimes(1);
    });

    it('with no transcription on the server (503), the mic goes away and the turn is the cards', async () => {
      stubNetwork({ draft: draftJson, status: statusBody(), streamToken: 503 });
      renderShell();
      await makeItMine();
      await onTurn(0);
      await waitFor(() => expect(funnel('v3_voice_input')).toEqual([{ state: 'unavailable' }]));
      expect(screen.queryByRole('button', { name: 'Answer out loud' })).not.toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.getByText('Tap one to hear it.')).toBeInTheDocument();
      await choose(turn(0).a);
      expect(await onTurn(1)).toBeInTheDocument();
      expect(requests.filter((r) => r.path.startsWith('/api/voice/stream-token'))).toHaveLength(1);
    });
  });

  describe('while an answer is being saved', () => {
    function holdTheSave() {
      let release: () => void = () => undefined;
      server.stageGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    }

    it('turns "Keep the rest as is" into a disabled "One moment…" and ignores the tap, so the save carries on to the next turn', async () => {
      stubNetwork({ draft: draftJson, status: statusBody() });
      renderShell();
      await makeItMine();
      await onTurn(0);
      const release = holdTheSave();
      await userEvent.click(screen.getByRole('radio', { name: turn(0).a }));
      await userEvent.click(screen.getByRole('button', { name: 'Next' }));

      const escape = await screen.findByRole('button', { name: 'One moment…' });
      expect(escape).toBeDisabled();
      await userEvent.click(escape);
      expect(funnel('v3_keep_rest')).toEqual([]);

      release();
      expect(await onTurn(1)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Keep the rest as is' })).toBeEnabled();
    });

    it('disables "Back" on an edit, so the owner is not moved or shown nothing when the save lands', async () => {
      stubNetwork({ draft: draftJson, status: statusBody() });
      renderShell();
      await userEvent.click(await screen.findByRole('button', { name: 'Looks right as is, skip the choices' }));
      await userEvent.click(await screen.findByRole('button', { name: /Getting paid/ }));
      await onTurn(3);
      const release = holdTheSave();
      await userEvent.click(screen.getByRole('radio', { name: turn(3).b }));
      await userEvent.click(screen.getByRole('button', { name: 'Save' }));

      expect(await screen.findByRole('button', { name: 'One moment…' })).toBeDisabled();
      expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument();

      release();
      expect(await screen.findByRole('heading', READBACK)).toBeInTheDocument();
    });
  });

  describe('focus', () => {
    it('lands on the new question after each answer, and on the read-back after Save', async () => {
      stubNetwork({ draft: draftJson, status: statusBody() });
      renderShell();
      await makeItMine();
      expect(await onTurn(0)).toHaveFocus();
      await choose(turn(0).a);
      expect(await onTurn(1)).toHaveFocus();

      await userEvent.click(screen.getByRole('button', { name: 'Keep the rest as is' }));
      const readback = await screen.findByRole('heading', READBACK);
      expect(readback).toHaveFocus();

      await userEvent.click(screen.getByRole('button', { name: /Getting paid/ }));
      expect(await onTurn(3)).toHaveFocus();
      await choose(turn(3).b, 'Save');
      expect(await screen.findByRole('heading', READBACK)).toHaveFocus();
    });
  });

  describe('resuming', () => {
    it('opens on the fourth turn when three are already answered', async () => {
      const draft = withChoices(draftJson, { greeting: { option: 'b' }, trip_fee_and_rate: { option: 'a' }, booking_posture: { option: 'a' } });
      stubNetwork({ draft, status: statusBody() });
      renderShell();

      expect(await onTurn(3)).toBeInTheDocument();
      expect(screen.getByText('About 5 minutes left')).toBeInTheDocument();
      expect(progress()).toBe('30');
      expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
      await choose(turn(3).b);
      expect(await onTurn(4)).toBeInTheDocument();
    });

    it('skips an answered turn that comes after the one in front of the owner', async () => {
      const draft = withChoices(draftJson, { greeting: { option: 'a' }, payment_collection_mode: { option: 'a' } });
      stubNetwork({ draft, status: statusBody() });
      renderShell();
      expect(await onTurn(1)).toBeInTheDocument();
      await choose(turn(1).a);
      await choose(turn(2).a);
      // Payment was already answered: straight on to hours.
      expect(await onTurn(4)).toBeInTheDocument();
    });

    it('opens on the read-back when all seven are answered', async () => {
      stubNetwork({ draft: fullyAnsweredDraft, status: statusBody() });
      renderShell();
      expect(await screen.findByRole('heading', READBACK)).toBeInTheDocument();
      expect(within(screen.getByRole('list')).getAllByRole('listitem')).toHaveLength(7);
    });

    it('opens on the read-back after the last unanswered turn when the rest were answered before', async () => {
      const draft = withChoices(fullyAnsweredDraft, {});
      const { after_hours_mode: _last, ...rest } = draft.choices;
      stubNetwork({ draft: { ...draft, choices: rest }, status: statusBody() });
      renderShell();
      expect(await onTurn(6)).toBeInTheDocument();
      await choose(turn(6).b);
      expect(await screen.findByRole('heading', READBACK)).toBeInTheDocument();
    });
  });

  describe('"Keep the rest as is"', () => {
    it('is in the header on every turn, and jumps from turn two to the read-back with the defaults', async () => {
      stubNetwork({ draft: draftJson, status: statusBody() });
      renderShell();
      await makeItMine();
      await onTurn(0);
      expect(screen.getByRole('button', { name: 'Keep the rest as is' })).toBeInTheDocument();
      await choose(turn(0).b);
      await onTurn(1);
      await userEvent.click(screen.getByRole('button', { name: 'Keep the rest as is' }));

      expect(await screen.findByRole('heading', READBACK)).toBeInTheDocument();
      const list = screen.getByRole('list');
      expect(within(list).getAllByRole('listitem')).toHaveLength(7);
      // One answer of their own, six defaults.
      expect(within(list).getByText(turn(0).b)).toBeInTheDocument();
      expect(within(list).getByText('$89 to come out, $150 an hour after')).toBeInTheDocument();
      expect(within(list).getByText(turn(2).a)).toBeInTheDocument();
      expect(within(list).getByText(turn(6).a)).toBeInTheDocument();
      expect(screen.getByText('About 3 minutes left')).toBeInTheDocument();
      expect(funnel('v3_keep_rest')).toEqual([{ answered_count: 1 }]);
      // Skipping stages nothing: only the one answer was ever sent.
      expect(stagedCalls()).toHaveLength(1);
    });

    it('then saves the defaults with one tap on "That\'s right"', async () => {
      stubNetwork({ draft: draftJson, status: statusBody() });
      renderShell();
      await makeItMine();
      await onTurn(0);
      await userEvent.click(screen.getByRole('button', { name: 'Keep the rest as is' }));
      await screen.findByRole('heading', READBACK);
      await userEvent.click(screen.getByRole('button', { name: "That's right" }));
      expect(await screen.findByText('Saving 2 changes. They go live in a few seconds.')).toBeInTheDocument();
      expect(funnel('v3_keep_rest')).toEqual([{ answered_count: 0 }]);
    });
  });

  describe('changing an answer from the read-back', () => {
    /** Straight from Ready when nothing is staged; otherwise from the turn the owner resumes on. */
    async function toReadback(draft: OnboardingDraft = draftJson, stagedAlready = false) {
      stubNetwork({ draft, status: statusBody() });
      renderShell();
      await userEvent.click(
        await screen.findByRole('button', { name: stagedAlready ? 'Keep the rest as is' : 'Looks right as is, skip the choices' }),
      );
      await screen.findByRole('heading', READBACK);
    }

    it('opens that turn in editing mode, with the current answer selected and a way back', async () => {
      await toReadback();
      await userEvent.click(screen.getByRole('button', { name: /Booking.*Book it on the call/ }));

      expect(await onTurn(2)).toBeInTheDocument();
      expect(funnel('v3_readback_edit')).toEqual([{ choice_key: 'booking_posture' }]);
      expect(screen.getByRole('radio', { name: turn(2).a })).toHaveAttribute('aria-checked', 'true');
      expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
      expect(screen.queryByRole('button', { name: 'Next' })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Back' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Keep the rest as is' })).not.toBeInTheDocument();
      expect(screen.getByText('Nothing saved yet')).toBeInTheDocument();
    });

    it('changes the answer and returns to the read-back, not on to the next turn', async () => {
      await toReadback();
      await userEvent.click(screen.getByRole('button', { name: /Booking.*Book it on the call/ }));
      await onTurn(2);
      await choose(turn(2).b, 'Save');

      expect(await screen.findByRole('heading', READBACK)).toBeInTheDocument();
      const list = screen.getByRole('list');
      expect(within(list).getByText(turn(2).b)).toBeInTheDocument();
      expect(within(list).queryByText(turn(2).a)).not.toBeInTheDocument();
      expect(within(list).getAllByRole('listitem')).toHaveLength(7);
      expect(stagedCalls().map((r) => [r.path, r.body?.choice])).toEqual([['/api/onboarding/draft/choices/booking_posture', { option: 'b' }]]);
      expect(funnel('v3_choice_made')).toEqual([{ choice_key: 'booking_posture', answer_mode: 'tap', option: 'b', is_most_shops: false }]);
    });

    it('goes back without changing anything', async () => {
      await toReadback();
      await userEvent.click(screen.getByRole('button', { name: /Getting paid/ }));
      await onTurn(3);
      await userEvent.click(screen.getByRole('button', { name: 'Back' }));
      expect(await screen.findByRole('heading', READBACK)).toBeInTheDocument();
      expect(stagedCalls()).toEqual([]);
    });

    it('stays on the editing turn, with the error, when the change cannot be saved', async () => {
      await toReadback();
      server.stageFaults = ['error'];
      await userEvent.click(screen.getByRole('button', { name: /Getting paid/ }));
      await onTurn(3);
      await choose(turn(3).b, 'Save');
      expect(await screen.findByRole('alert')).toHaveTextContent("That didn't go through. Try again.");
      expect(screen.getByRole('heading', { level: 1, name: turn(3).question })).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'Back' }));
      expect(await screen.findByRole('heading', READBACK)).toBeInTheDocument();
    });

    it('reopens a typed price in its fields, and a new price replaces the old one', async () => {
      const typed = withChoices(draftJson, {
        trip_fee_and_rate: { override: { label: '$120 to come out, then $175 an hour', writes: {}, prices: { tripFeeCents: 12000, hourlyRateCents: 17500 } } },
      });
      await toReadback(typed, true);
      expect(screen.getByText('$120 to come out, $175 an hour after')).toBeInTheDocument();
      expect(screen.queryByText(/Typical for/)).not.toBeInTheDocument();

      await userEvent.click(screen.getByRole('button', { name: /Prices/ }));
      await onTurn(1);
      expect(screen.getByRole('textbox', { name: 'To come out' })).toHaveValue('$120');
      expect(screen.getByRole('textbox', { name: 'Per hour' })).toHaveValue('$175');
      await userEvent.clear(screen.getByRole('textbox', { name: 'Per hour' }));
      await userEvent.type(screen.getByRole('textbox', { name: 'Per hour' }), '180.50');
      await userEvent.click(screen.getByRole('button', { name: 'Save' }));

      expect(await screen.findByRole('heading', READBACK)).toBeInTheDocument();
      expect(screen.getByText('$120 to come out, $180.50 an hour after')).toBeInTheDocument();
      expect(funnel('v3_choice_made')).toEqual([{ choice_key: 'trip_fee_and_rate', answer_mode: 'type', option: 'override', is_most_shops: false }]);
    });

    it('never lowers the progress line, and does not count a turn viewed twice twice', async () => {
      await toReadback();
      expect(progress()).toBe('50');
      await userEvent.click(screen.getByRole('button', { name: /Booking/ }));
      await onTurn(2);
      expect(progress()).toBe('50');
      await userEvent.click(screen.getByRole('button', { name: 'Back' }));
      await screen.findByRole('heading', READBACK);
      await userEvent.click(screen.getByRole('button', { name: /Booking/ }));
      await onTurn(2);
      expect(progress()).toBe('50');
      expect(funnel('v3_turn_viewed')).toEqual([{ choice_key: 'booking_posture' }]);
      expect(funnel('v3_readback_edit')).toEqual([{ choice_key: 'booking_posture' }, { choice_key: 'booking_posture' }]);
    });

    it('does not carry a read-back save error onto the turn that is opened to fix it', async () => {
      await toReadback();
      server.approveFails = true;
      await userEvent.click(screen.getByRole('button', { name: "That's right" }));
      expect(await screen.findByRole('alert')).toHaveTextContent("That didn't go through. Try again.");
      await userEvent.click(screen.getByRole('button', { name: /Booking/ }));
      await onTurn(2);
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'Back' }));
      await screen.findByRole('heading', READBACK);
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
  });

  it('goes from Ready to the read-back by "Looks right as is", then approves with one tap and shows the two saved changes', async () => {
    stubNetwork({ draft: draftJson, status: statusBody() });
    renderShell();

    await userEvent.click(await screen.findByRole('button', { name: 'Looks right as is, skip the choices' }));
    expect(await screen.findByRole('heading', READBACK)).toBeInTheDocument();
    expect(screen.getByText('Waiting for your OK')).toBeInTheDocument();
    expect(screen.getByText('About 3 minutes left')).toBeInTheDocument();
    expect(track.trackFunnel).toHaveBeenCalledWith('v3_readback_viewed', expect.anything(), expect.anything());
    expect(draftCalls()).not.toContain('POST /api/onboarding/draft/approve');

    await userEvent.click(screen.getByRole('button', { name: "That's right" }));

    expect(await screen.findByText('Saving 2 changes. They go live in a few seconds.')).toBeInTheDocument();
    expect(draftCalls()).toContain('POST /api/onboarding/draft/approve');
    expect(track.trackFunnel).toHaveBeenCalledWith('v3_approved', expect.anything(), expect.objectContaining({ proposal_count: 2 }));
    expect(track.trackFunnel.mock.calls.filter(([e]) => e === 'v3_approved')).toHaveLength(1);
  });

  it('after the saving window continues into the trial, in the same frame, once the choices are live', async () => {
    stubNetwork({ draft: draftJson, status: statusAt('billing') });
    renderShell();
    await userEvent.click(await screen.findByRole('button', { name: 'Looks right as is, skip the choices' }));
    await userEvent.click(await screen.findByRole('button', { name: "That's right" }));

    expect(await screen.findByText(/Saving 2 changes/)).toBeInTheDocument();
    expect(screen.getByText('Saving')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { level: 1, name: /start your free trial/ })).toBeInTheDocument();
    expect(await screen.findByRole('radio', { name: /Starter/ })).toBeInTheDocument();
    expect(screen.getByText('About 3 minutes left')).toBeInTheDocument();
    expect(progress()).toBe('70');
    expect(screen.queryByText('v2 shell')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Keep the rest as is|Back/ })).not.toBeInTheDocument();
  });

  it('keeps waiting, not guessing, while the saved choices have not gone live yet', async () => {
    stubNetwork({ draft: approvedJson, status: statusAt('identity') });
    renderShell();
    expect(await screen.findByRole('heading', { level: 1, name: 'Getting your shop ready.' })).toBeInTheDocument();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    expect(screen.queryByText('v2 shell')).not.toBeInTheDocument();
  });

  it('resumes an already-saved shop at the trial with no saving window', async () => {
    stubNetwork({ draft: approvedJson, status: statusAt('billing') });
    renderShell();
    expect(await screen.findByRole('heading', { level: 1, name: /start your free trial/ })).toBeInTheDocument();
    expect(screen.queryByText(/Saving 2 changes/)).not.toBeInTheDocument();
  });

  it('carries on to the number in the same frame once the trial is done, never into the old shell', async () => {
    stubNetwork({ draft: approvedJson, status: statusAt('phone') });
    renderShell();
    expect(await screen.findByRole('heading', { level: 1, name: 'Getting your number.' })).toBeInTheDocument();
    expect(screen.getByText('About 2 minutes left')).toBeInTheDocument();
    expect(screen.queryByText('v2 shell')).not.toBeInTheDocument();
  });

  it('asks what to answer as when there is no draft, then creates it with the browser timezone', async () => {
    stubNetwork({ draft: null, status: statusBody() });
    renderShell();

    expect(await screen.findByRole('heading', { level: 1, name: 'What should I answer as?' })).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Business name'), 'Walsh Plumbing');
    await userEvent.click(screen.getByRole('button', { name: 'Plumbing' }));
    await userEvent.type(screen.getByLabelText('Your cell'), '(216) 555-0142');
    await userEvent.click(screen.getByRole('button', { name: 'Show me my shop' }));

    expect(await screen.findByRole('heading', { level: 1, name: 'Walsh Plumbing is already set up.' })).toBeInTheDocument();
    const create = requests.find((r) => r.method === 'POST' && r.path === '/api/onboarding/draft');
    expect(create?.body).toEqual({
      packId: 'plumbing',
      businessName: 'Walsh Plumbing',
      phone: '(216) 555-0142',
      ownerFirstName: 'Ada',
      clientTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
  });

  /** The new owner's form, filled in and sent. */
  async function sendTheForm(cell = '(216) 555-0142') {
    expect(await screen.findByRole('heading', { level: 1, name: 'What should I answer as?' })).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Business name'), 'Walsh Plumbing');
    await userEvent.click(screen.getByRole('button', { name: 'Plumbing' }));
    await userEvent.type(screen.getByLabelText('Your cell'), cell);
    await userEvent.click(screen.getByRole('button', { name: 'Show me my shop' }));
  }
  const creates = () => requests.filter((r) => r.method === 'POST' && r.path === '/api/onboarding/draft');

  it('needs the owner\'s cell before it will make the shop: the button stays off without one', async () => {
    stubNetwork({ draft: null, status: statusBody() });
    renderShell();
    await screen.findByRole('heading', { level: 1, name: 'What should I answer as?' });
    await userEvent.type(screen.getByLabelText('Business name'), 'Walsh Plumbing');
    await userEvent.click(screen.getByRole('button', { name: 'Plumbing' }));
    expect(screen.getByRole('button', { name: 'Show me my shop' })).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Your cell'), '+44 7911 123456');
    expect(screen.getByRole('button', { name: 'Show me my shop' })).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Your cell'), '{Enter}');
    expect(creates()).toHaveLength(0);
  });

  it('takes the owner back to the form with the API\'s reason when it refuses the cell, keeping what they typed', async () => {
    stubNetwork({ draft: null, status: statusBody(), createFaults: ['refused_cell'] });
    renderShell();
    await sendTheForm();

    // Not "I couldn't load your setup": the form, with the reason on the cell and nothing lost.
    expect(await screen.findByRole('alert')).toHaveTextContent(REFUSED_CELL);
    expect(screen.getByRole('heading', { level: 1, name: 'What should I answer as?' })).toBeInTheDocument();
    expect(screen.queryByText(/couldn't load your setup/)).not.toBeInTheDocument();
    expect(screen.getByLabelText('Business name')).toHaveValue('Walsh Plumbing');
    expect(screen.getByRole('button', { name: 'Plumbing' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText('Your cell')).toHaveValue('(216) 555-0142');
    // The same cell is not sent again; a different one is.
    expect(screen.getByRole('button', { name: 'Show me my shop' })).toBeDisabled();

    await userEvent.clear(screen.getByLabelText('Your cell'));
    await userEvent.type(screen.getByLabelText('Your cell'), '216-555-0199');
    await userEvent.click(screen.getByRole('button', { name: 'Show me my shop' }));

    expect(await screen.findByRole('heading', { level: 1, name: 'Walsh Plumbing is already set up.' })).toBeInTheDocument();
    expect(creates().map((r) => (r.body as { phone?: string }).phone)).toEqual(['(216) 555-0142', '216-555-0199']);
  });

  it('lets an owner whose create failed some other way change their answers, not only resend them', async () => {
    stubNetwork({ draft: null, status: statusBody(), createFaults: ['error'] });
    const { container } = renderShell();
    await sendTheForm();

    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent("I couldn't load your setup.");
    expectAllTapTargets(container, 'load problem after a failed create');
    await userEvent.click(screen.getByRole('button', { name: 'Change my answers' }));

    expect(await screen.findByRole('heading', { level: 1, name: 'What should I answer as?' })).toBeInTheDocument();
    expect(screen.getByLabelText('Business name')).toHaveValue('Walsh Plumbing');
    expect(screen.getByRole('button', { name: 'Plumbing' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText('Your cell')).toHaveValue('(216) 555-0142');
    await userEvent.click(screen.getByRole('button', { name: 'Show me my shop' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Walsh Plumbing is already set up.' })).toBeInTheDocument();
    expect(creates()).toHaveLength(2);
  });

  it('says so, and offers a retry, when the setup cannot be loaded', async () => {
    stubNetwork({ draft: draftJson, status: statusBody() });
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        if (String(input) === '/api/onboarding/status') return resolved(json(200, statusBody()));
        return resolved(json(500, { error: 'INTERNAL', message: 'boom' }));
      }),
    );
    renderShell();
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent("I couldn't load your setup.");
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    // Nothing was typed yet, so there are no answers to change.
    expect(screen.queryByRole('button', { name: 'Change my answers' })).not.toBeInTheDocument();
  });

  it('sends a finished setup home', async () => {
    stubNetwork({ draft: approvedJson, status: statusBody({ currentStep: null, isComplete: true }) });
    renderShell();
    expect(await screen.findByText('home page')).toBeInTheDocument();
  });

  it('opens the existing shell for an explicit re-run of setup', async () => {
    stubNetwork({ draft: draftJson, status: statusBody() });
    renderShell('/onboarding?rerun=1');
    expect(await screen.findByText('v2 shell')).toBeInTheDocument();
    expect(draftCalls()).toEqual([]);
  });

  it('never shows the owner a screen with more than one h1', async () => {
    stubNetwork({ draft: draftJson, status: statusBody() });
    const { container } = renderShell();
    await screen.findByRole('heading', { level: 1 });
    expect(within(container).getAllByRole('heading', { level: 1 })).toHaveLength(1);
    await makeItMine();
    await onTurn(0);
    expect(within(container).getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });
});
