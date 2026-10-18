/**
 * ConversationShell against the real hooks with the network stubbed at `fetch`.
 * The draft is a fixture captured from the API (pinned to the shared contract
 * in __fixtures__), so the screens render what the API really sends. The stub
 * server behaves like the draft routes: PUT /choices/:key is a compare-and-swap
 * on `version` that merges the staged choice and bumps it.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import type { OnboardingDraft } from '@ai-service-os/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fullyAnsweredDraft, plumbingCleDraft, withChoices } from './__fixtures__';
import { PLANS, statusAt } from './__fixtures__/after';
import { _resetOnboardingStatusCacheForTests } from '../../../hooks/useOnboardingStatus';

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

interface Server {
  draft: OnboardingDraft | null;
  status: object;
  /** Forced outcomes for the next staged choices, in order; after that the stub behaves. */
  stageFaults?: StageFault[];
  /** Make "That's right" fail with a server error. */
  approveFails?: boolean;
  /** Hold the next staged choice until this settles, so a test can act while a save is in flight. */
  stageGate?: Promise<void>;
}

interface Request {
  method: string;
  path: string;
  body: { choice?: unknown; version?: number } | undefined;
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
      if (path === '/api/onboarding/status') return resolved(json(200, server.status));
      if (path === '/api/onboarding/billing/plans') return resolved(json(200, { plans: PLANS }));
      if (path === '/api/onboarding/draft' && method === 'GET') {
        return resolved(
          server.draft ? json(200, { draft: server.draft }) : json(404, { error: 'NOT_FOUND', message: 'OnboardingDraft not found' }),
        );
      }
      if (path === '/api/onboarding/draft' && method === 'POST') {
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
  });
  afterEach(() => {
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
      expect(screen.getByText('Tap one to hear it. Say "first" or "second" to pick.')).toBeInTheDocument();
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
