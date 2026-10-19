/**
 * Everything after "That's right", through the real shell, hooks and API client
 * with the network stubbed at `fetch`. The shop is already saved (the draft is
 * approved), so what is under test is the status the API derives: the owner
 * moves through the wait, the trial, the number, the voice getting ready and the
 * test call as that status changes between polls, in the same frame, and the
 * old sidebar shell is reached only by an explicit re-run. Timers are fake so a
 * poll is one tick; every stub route answers like the real one (a retry or a
 * skip changes what the next status says).
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import type { OnboardingDraft } from '@ai-service-os/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetOnboardingStatusCacheForTests } from '../../../hooks/useOnboardingStatus';
import type { OnboardingStatusResponse } from '../../../types/onboarding';
import { expectAllTapTargets } from '../../../test-utils/tap-target';
import { plumbingCleDraft, withChoices } from './__fixtures__';
import { PLANS, json, statusAt } from './__fixtures__/after';

const track = vi.hoisted(() => ({ trackFunnel: vi.fn(), track: vi.fn() }));
vi.mock('../../../lib/analytics', () => track);
vi.mock('../v2/OnboardingShell', () => ({ OnboardingShell: () => <div>v2 shell</div> }));

import { ConversationShell } from './ConversationShell';

const NUMBER = '+12165550180';
const approved: OnboardingDraft = {
  ...plumbingCleDraft,
  status: 'approved',
  version: 2,
  proposalIds: ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'],
  approvedAt: '2026-10-18T10:05:00.000Z',
};

type Patch = Parameters<typeof statusAt>[1];
const phoneDone: Patch = { phone: { status: 'done', metadata: { phoneNumber: NUMBER } } };

let world: { status: OnboardingStatusResponse };
let requests: string[];
/** Every request with the JSON body it carried, for the version checks. */
let sent: Array<{ call: string; body: unknown }>;
let routes: Record<string, ((body?: unknown) => Response | Promise<Response>) | undefined>;

function stub(status: OnboardingStatusResponse, extra: typeof routes = {}) {
  world = { status };
  requests = [];
  sent = [];
  routes = {
    'GET /api/onboarding/status': () => json(200, world.status),
    'GET /api/onboarding/draft': () => json(200, { draft: approved }),
    'GET /api/onboarding/billing/plans': () => json(200, { plans: PLANS }),
    'POST /api/onboarding/billing/cancel': () => json(200, { ok: true }),
    'POST /api/onboarding/phone/retry': () => json(200, { ok: true, enqueued: true }),
    'POST /api/onboarding/ai-check/retry': () => json(200, { ok: true, enqueued: true }),
    'POST /api/onboarding/ai-check/skip': () => json(200, { ok: true, skipped: true }),
    'POST /api/onboarding/test-call/skip': () => {
      world.status = statusAt(null, { ...phoneDone, test_call: { status: 'skipped' } });
      return json(200, { ok: true });
    },
    'POST /api/voice/go-live': () => {
      world.status = { ...world.status, voiceAgentLive: true };
      return json(200, { ok: true });
    },
    ...extra,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const call = `${init?.method ?? 'GET'} ${String(input)}`;
      requests.push(call);
      const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      sent.push({ call, body });
      const handler = routes[call];
      if (!handler) throw new Error(`unexpected request ${call}`);
      return Promise.resolve(handler(body));
    }),
  );
}

function Where() {
  const { pathname, search } = useLocation();
  return <div data-testid="where">{pathname + search}</div>;
}

function renderShell(url = '/onboarding') {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/onboarding" element={<ConversationShell />} />
        <Route path="/" element={<div>home page</div>} />
      </Routes>
      <Where />
    </MemoryRouter>,
  );
}

/** Let the pending requests and renders finish, without moving the clock. */
const settle = () =>
  act(async () => {
    for (let i = 0; i < 4; i += 1) await vi.advanceTimersByTimeAsync(0);
  });
const tick = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
    for (let i = 0; i < 3; i += 1) await vi.advanceTimersByTimeAsync(0);
  });
/** The API is polled every three seconds. */
const nextPoll = () => tick(3_000);

const heading = () => screen.getByRole('heading', { level: 1 });
const progress = () => screen.getByRole('progressbar', { name: 'Setup progress' }).getAttribute('aria-valuenow');
const where = () => screen.getByTestId('where').textContent;
const fired = (event: string) => track.trackFunnel.mock.calls.filter(([e]) => e === event);
/** The header's one way out, when there is one. */
const headerEscape = () => document.querySelector('header')?.querySelector('button') ?? null;

function expectFrame(minutes: number, percent: number, label: string) {
  expect(screen.getByText(`About ${minutes} ${minutes === 1 ? 'minute' : 'minutes'} left`)).toBeInTheDocument();
  expect(progress()).toBe(String(percent));
  expect(within(document.querySelector('header') as HTMLElement).getByText(label)).toBeInTheDocument();
}

describe('ConversationShell after "That\'s right"', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _resetOnboardingStatusCacheForTests();
    track.trackFunnel.mockClear();
    track.track.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  describe('while the saved choices go live', () => {
    it('says it is getting the shop ready, then that it is still here, then admits it is slow and offers Check again', async () => {
      stub(statusAt('identity'));
      const { container } = renderShell();
      await settle();

      expect(heading()).toHaveTextContent('Getting your shop ready.');
      expect(screen.getByText('This takes a few seconds.')).toBeInTheDocument();
      expectFrame(3, 65, 'Saving');
      expect(screen.queryByText('Still with you.')).not.toBeInTheDocument();
      expect(screen.queryByRole('button')).not.toBeInTheDocument();

      // The status is polled all the while; seeing the same answer again does not restart the clock.
      await tick(3_999);
      expect(screen.queryByText('Still with you.')).not.toBeInTheDocument();
      await tick(1);
      expect(screen.getByRole('status')).toHaveTextContent('Still with you.');
      expect(screen.queryByRole('button', { name: 'Check again' })).not.toBeInTheDocument();

      await tick(15_999);
      expect(screen.queryByText('This is taking longer than usual.')).not.toBeInTheDocument();
      await tick(1);
      expect(screen.getByRole('status')).toHaveTextContent('This is taking longer than usual.');
      expect(screen.queryByText('Still with you.')).not.toBeInTheDocument();
      // Honest about it: the choices may not have saved, and there is a way out that is not another look at the same status.
      expect(screen.getByText(/Some of your choices may not have saved/)).toBeInTheDocument();
      const stepByStep = screen.getByRole('button', { name: 'Go through setup step by step' });
      // The label wraps instead of spilling past the button at 320px, like every other full-width v3 action.
      expect(stepByStep.className).toMatch(/whitespace-normal/);
      // The note speaks the button's language: it is a look at the status again.
      expect(screen.getByText(/You can check again, or go through setup step by step/)).toBeInTheDocument();
      // It only looks at the status again, so it does not claim to retry anything.
      expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
      expectAllTapTargets(container, 'the slow wait');

      // Check again asks the API again, and the shop is live: the trial takes over.
      world.status = statusAt('billing');
      fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
      await settle();
      expect(heading()).toHaveTextContent(/start your free trial/);
      expect(requests.filter((r) => r === 'GET /api/onboarding/status').length).toBeGreaterThan(1);
    });

    it('keeps the slow note and the step-by-step way out off the screen until it is slow, and the way out opens the step-by-step setup', async () => {
      stub(statusAt('identity'));
      renderShell();
      await settle();
      await tick(19_999);
      expect(screen.queryByText(/may not have saved/)).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Go through setup step by step' })).not.toBeInTheDocument();
      await tick(1);

      fireEvent.click(screen.getByRole('button', { name: 'Go through setup step by step' }));
      await settle();
      expect(where()).toBe('/onboarding?rerun=1');
      expect(screen.getByText('v2 shell')).toBeInTheDocument();
    });

    it('moves on by itself when a later poll says the choices are live', async () => {
      stub(statusAt('identity'));
      renderShell();
      await settle();
      expect(heading()).toHaveTextContent('Getting your shop ready.');
      world.status = statusAt('pack');
      await nextPoll();
      expect(heading()).toHaveTextContent('Getting your shop ready.');
      world.status = statusAt('billing');
      await nextPoll();
      expect(heading()).toHaveTextContent(/start your free trial/);
    });
  });

  describe('when a saved change did not go live', () => {
    const savedAs = (execution: 'pending' | 'failed' | 'stopped') =>
      statusAt('identity', {}, { draft: { status: 'approved', choicesAnswered: 7, version: 2, execution } });
    const retries = () => requests.filter((r) => r === 'POST /api/onboarding/draft/retry');
    const statusReads = () => requests.filter((r) => r === 'GET /api/onboarding/status').length;

    it('tells the owner it did not save, offers Try again at once (not after the slow wait), and a retry puts the wait back', async () => {
      let release: (res: Response) => void = () => undefined;
      stub(savedAs('failed'), {
        'POST /api/onboarding/draft/retry': () => {
          world.status = savedAs('pending');
          return new Promise<Response>((resolve) => {
            release = resolve;
          });
        },
      });
      const { container } = renderShell();
      await settle();

      expect(heading()).toHaveTextContent("Something didn't save.");
      expect(screen.getByText(/safe to try again/)).toBeInTheDocument();
      expect(screen.queryByText('Getting your shop ready.')).not.toBeInTheDocument();
      expect(screen.queryByText('Still with you.')).not.toBeInTheDocument();
      expectFrame(3, 65, 'Not saved');
      expectAllTapTargets(container, 'the failed save');
      const tryAgain = screen.getByRole('button', { name: 'Try again' });
      expect(tryAgain.className).toMatch(/min-h-11|h-14/);

      fireEvent.click(tryAgain);
      await settle();
      // A second tap while the first is in flight sends nothing.
      const busy = screen.getByRole('button', { name: /Try again/ });
      fireEvent.click(busy);
      await settle();
      expect(retries()).toHaveLength(1);
      expect(busy).toHaveAttribute('aria-busy', 'true');
      expect(busy).toBeDisabled();

      const before = statusReads();
      release(json(200, { draft: approved, retriedProposalIds: [approved.proposalIds[1]] }));
      await settle();
      expect(retries()).toHaveLength(1);
      // The status the shell shares was out of date the moment the retry went through: it asks again for real.
      expect(statusReads()).toBeGreaterThan(before);
      expect(heading()).toHaveTextContent('Getting your shop ready.');
      expect(screen.queryByText("Something didn't save.")).not.toBeInTheDocument();
    });

    it('keeps the 20 second slow note for a save that is only pending, and says nothing of a failure there', async () => {
      stub(savedAs('pending'));
      renderShell();
      await settle();
      expect(heading()).toHaveTextContent('Getting your shop ready.');
      await tick(20_000);
      expect(screen.getByText(/Some of your choices may not have saved/)).toBeInTheDocument();
      expect(screen.queryByText("Something didn't save.")).not.toBeInTheDocument();
    });

    it('on a 409 from the retry re-reads the status: it moved on (the change was undone), so the owner gets the way out, not a dead button', async () => {
      stub(savedAs('failed'), {
        'POST /api/onboarding/draft/retry': () => {
          world.status = savedAs('stopped');
          return json(409, { error: 'CONFLICT', message: 'DRAFT_RETRY_NOTHING_FAILED: no proposal is in execution_failed' });
        },
      });
      renderShell();
      await settle();
      const before = statusReads();
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
      await settle();

      expect(retries()).toHaveLength(1);
      expect(statusReads()).toBeGreaterThan(before);
      expect(heading()).toHaveTextContent('Part of your setup was taken back.');
      expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    });

    it('on a 409 where the status still says failed, or any other error, shows one plain line and lets the owner tap again', async () => {
      stub(savedAs('failed'), {
        'POST /api/onboarding/draft/retry': () =>
          json(409, { error: 'CONFLICT', message: 'DRAFT_RETRY_FAILED: the change could not be queued again' }),
      });
      renderShell();
      await settle();
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
      await settle();
      expect(screen.getByRole('alert')).toHaveTextContent("That didn't go through. Try again.");
      expect(heading()).toHaveTextContent("Something didn't save.");

      routes['POST /api/onboarding/draft/retry'] = () => {
        throw new TypeError('network down');
      };
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
      await settle();
      expect(screen.getByRole('alert')).toHaveTextContent("I couldn't reach the server");
      expect(screen.getByRole('button', { name: 'Try again' })).not.toHaveAttribute('aria-busy');
      expect(retries()).toHaveLength(2);
    });

    it('moves focus onto the new heading when the wait turns into a failed or an undone save, so the change is announced', async () => {
      stub(savedAs('pending'));
      renderShell();
      await settle();
      expect(heading()).toHaveTextContent('Getting your shop ready.');

      world.status = savedAs('failed');
      await nextPoll();
      expect(heading()).toHaveTextContent("Something didn't save.");
      expect(heading()).toHaveFocus();
    });

    it('moves focus onto the heading when the wait turns into an undone save', async () => {
      stub(savedAs('pending'));
      renderShell();
      await settle();

      world.status = savedAs('stopped');
      await nextPoll();
      expect(heading()).toHaveTextContent('Part of your setup was taken back.');
      expect(heading()).toHaveFocus();
    });

    it('does not show an old retry error again when the failed save comes back after the wait', async () => {
      stub(savedAs('failed'), {
        'POST /api/onboarding/draft/retry': () => {
          // The retry went through on the server but the answer never arrived.
          world.status = savedAs('pending');
          throw new TypeError('network down');
        },
      });
      renderShell();
      await settle();
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
      await settle();
      expect(heading()).toHaveTextContent('Getting your shop ready.');

      world.status = savedAs('failed');
      await nextPoll();
      expect(heading()).toHaveTextContent("Something didn't save.");
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('lets the owner go through setup step by step instead, when trying again does not help', async () => {
      stub(savedAs('failed'));
      renderShell();
      await settle();
      fireEvent.click(screen.getByRole('button', { name: 'Go through setup step by step' }));
      await settle();
      expect(where()).toBe('/onboarding?rerun=1');
      expect(retries()).toHaveLength(0);
    });

    it('does not move on to the trial while the other saved change did not go live: the settings are done but the voice policy failed', async () => {
      const settingsDone = (execution: 'pending' | 'failed' | 'stopped') =>
        statusAt('billing', {}, { draft: { status: 'approved', choicesAnswered: 7, version: 2, execution } });
      stub(settingsDone('failed'), {
        'POST /api/onboarding/draft/retry': () => {
          world.status = settingsDone('pending');
          return json(200, { draft: approved, retriedProposalIds: [approved.proposalIds[1]] });
        },
      });
      renderShell();
      await settle();

      expect(heading()).toHaveTextContent("Something didn't save.");
      expectFrame(3, 65, 'Not saved');
      expect(screen.queryByRole('button', { name: /trial/i })).not.toBeInTheDocument();

      // Once the retry has gone through, the setup carries on from where the status says it is.
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
      await settle();
      expect(screen.queryByText("Something didn't save.")).not.toBeInTheDocument();
    });

    it('against an API with no way-out hint, says part of the setup was taken back and offers the step-by-step setup as the only action, never a retry', async () => {
      stub(savedAs('stopped'));
      const { container } = renderShell();
      await settle();

      expect(heading()).toHaveTextContent('Part of your setup was taken back.');
      expect(screen.getByText(/can't finish setup from here/)).toBeInTheDocument();
      expectFrame(3, 65, 'Not finished');
      expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Check again' })).not.toBeInTheDocument();
      expect(screen.getAllByRole('button')).toHaveLength(1);
      expectAllTapTargets(container, 'the stopped save');
      // Even long after, the action is there from the start and no retry ever appears.
      await tick(25_000);
      expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Go through setup step by step' }));
      await settle();
      expect(where()).toBe('/onboarding?rerun=1');
      expect(screen.getByText('v2 shell')).toBeInTheDocument();
      expect(requests.filter((r) => r.includes('/retry') && r.includes('draft'))).toEqual([]);
    });

    it('does nothing different against an API that has no execution state: the wait stays the wait', async () => {
      stub(statusAt('identity', {}, { draft: { status: 'approved', choicesAnswered: 7, version: 2 } }));
      renderShell();
      await settle();
      expect(heading()).toHaveTextContent('Getting your shop ready.');
      await tick(25_000);
      expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
      expect(requests.some((r) => r.includes('/draft/retry'))).toBe(false);
    });
  });

  describe('Undo, Try again and Start over', () => {
    const IDS = approved.proposalIds;
    /** Every answer staged (greeting is the owner's own), so the read-back is where an editable draft opens. */
    const answered = withChoices(plumbingCleDraft, {
      greeting: { option: 'b' },
      trip_fee_and_rate: { option: 'a' },
      booking_posture: { option: 'a' },
      payment_collection_mode: { option: 'a' },
      booking_hours: { option: 'a' },
      emergency_target: { option: 'a' },
      after_hours_mode: { option: 'a' },
    });
    const OWN_GREETING = "Thanks for calling Walsh Plumbing. What's going on today?";
    let current: OnboardingDraft;
    const approvedAt = (version: number): OnboardingDraft => ({
      ...answered,
      status: 'approved',
      version,
      proposalIds: IDS,
      approvedAt: '2026-10-18T10:05:00.000Z',
    });
    const editableAt = (version: number): OnboardingDraft => ({ ...answered, version });
    type DraftBlock = NonNullable<OnboardingStatusResponse['draft']>;
    /** The status as the API derives it for the draft the server holds now. */
    const statusNow = (over: Partial<DraftBlock> = {}, step: Parameters<typeof statusAt>[0] = 'identity') =>
      statusAt(step, {}, { draft: { status: current.status, choicesAnswered: 7, version: current.version, ...over } });
    const conflict = (message: string, details?: object) => json(409, { error: 'CONFLICT', message, ...(details ? { details } : {}) });
    const versionOf = (path: string) => sent.filter((r) => r.call === `POST /api/onboarding/draft/${path}`).map((r) => (r.body as { expectedVersion?: number }).expectedVersion);
    const undoButton = () => screen.queryByRole('button', { name: 'Undo' });
    const READBACK = "Here's what I've got. Tap anything to change it.";

    /** The draft routes, answering like the real ones against `current`. */
    function draftRoutes(): typeof routes {
      return {
        'GET /api/onboarding/draft': () => json(200, { draft: current }),
        'POST /api/onboarding/draft/approve': () => {
          current = approvedAt(current.version + 1);
          world.status = statusNow({ execution: 'pending', undoable: true });
          return json(200, { draft: current, proposalIds: IDS, approvedNow: true });
        },
        'POST /api/onboarding/draft/undo': (body) => {
          const v = (body as { expectedVersion: number }).expectedVersion;
          if (current.status !== 'approved') return conflict('DRAFT_NOT_APPROVED: the draft has not been approved');
          if (v !== current.version) return conflict(`VERSION_CONFLICT: expected ${v}, found ${current.version}; re-read the draft`);
          current = editableAt(current.version + 1);
          world.status = statusNow();
          return json(200, { draft: current });
        },
        'POST /api/onboarding/draft/reset': (body) => {
          const v = (body as { expectedVersion: number }).expectedVersion;
          if (v !== current.version) return conflict(`VERSION_CONFLICT: expected ${v}, found ${current.version}; re-read the draft`);
          current = editableAt(current.version + 1);
          world.status = statusNow();
          return json(200, { draft: current });
        },
        'POST /api/onboarding/draft/retry': (body) => {
          const v = (body as { expectedVersion: number }).expectedVersion;
          if (v !== current.version) return conflict(`VERSION_CONFLICT: expected ${v}, found ${current.version}; re-read the draft`);
          current = approvedAt(current.version + 1);
          world.status = statusNow({ execution: 'pending', undoable: true });
          return json(200, { draft: current, retriedProposalIds: IDS, undoable: true });
        },
      };
    }

    /** From the read-back of an answered draft, through "That's right", to the saving window. */
    async function approveFromReadback() {
      current = editableAt(7);
      stub(statusNow(), draftRoutes());
      const view = renderShell();
      await settle();
      expect(heading()).toHaveTextContent(READBACK);
      fireEvent.click(screen.getByRole('button', { name: "That's right" }));
      await settle();
      return view;
    }

    /** An approved draft the shell finds on load, with the status the API derives for it. */
    async function openOn(draft: OnboardingDraft, over: Partial<DraftBlock>, extra: typeof routes = {}) {
      current = draft;
      stub(statusNow(over), { ...draftRoutes(), ...extra });
      const view = renderShell();
      await settle();
      return view;
    }

    function expectPlainWords() {
      const text = document.body.textContent;
      for (const word of [/approved/i, /undone/i, /409/, /proposal/i, /\bAI\b/, /verify/i]) expect(text, String(word)).not.toMatch(word);
    }

    describe('Undo during the saving window', () => {
      it('shows right after "That\'s right", before any poll, posts the version approve returned, and lands on the read-back with the answers intact', async () => {
        const { container } = await approveFromReadback();
        expect(heading()).toHaveTextContent('Saving your choices.');
        expect(screen.getByText("Tap Undo if that's not right.")).toBeInTheDocument();
        expect(undoButton()).not.toBeNull();
        expect(undoButton()!.className).toMatch(/w-full/);
        expectAllTapTargets(container, 'the saving window with Undo');
        expectPlainWords();
        const before = requests.length;

        fireEvent.click(undoButton()!);
        await settle();
        expect(versionOf('undo')).toEqual([8]);
        expect(heading()).toHaveTextContent(READBACK);
        expect(screen.getByText(OWN_GREETING)).toBeInTheDocument();
        expect(screen.queryByText('This changed in another window.')).not.toBeInTheDocument();
        expect(requests.slice(before)).toEqual(['POST /api/onboarding/draft/undo']);
        expect(fired('v3_undo')).toHaveLength(1);

        // The owner can change their mind back: the second approval goes through from the version undo returned.
        fireEvent.click(screen.getByRole('button', { name: "That's right" }));
        await settle();
        expect(versionOf('approve')).toEqual([7, 9]);
        expect(heading()).toHaveTextContent('Saving your choices.');
      });

      it('drops the button on the poll that says the window has closed, with nothing tapped and nothing sent', async () => {
        await approveFromReadback();
        // The first poll, inside the window: still undoable.
        await nextPoll();
        expect(undoButton()).not.toBeNull();
        // The hint is a second early: by the next look the API says no.
        world.status = statusNow({ execution: 'pending', undoable: false });
        const before = requests.length;
        await tick(1_500);
        // The shell polls on its own; it sends nothing else.
        await nextPoll();
        expect(undoButton()).toBeNull();
        expect(requests.slice(before).every((r) => r === 'GET /api/onboarding/status')).toBe(true);
      });

      for (const [name, message] of [
        ['the window closed', "UNDO_WINDOW_CLOSED: It's too late to undo this."],
        ['part of it is being saved', "DRAFT_UNDO_REFUSED: This can't be undone all at once any more, because part of it is being saved right now."],
      ] as const) {
        it(`a tap on a stale hint (${name}) asks the status again, drops the button and keeps waiting`, async () => {
          await approveFromReadback();
          routes['POST /api/onboarding/draft/undo'] = () => {
            world.status = statusNow({ execution: 'executing', undoable: false });
            return conflict(message);
          };
          const reads = requests.filter((r) => r === 'GET /api/onboarding/status').length;
          fireEvent.click(undoButton()!);
          await settle();
          expect(requests.filter((r) => r === 'GET /api/onboarding/status').length).toBeGreaterThan(reads);
          expect(undoButton()).toBeNull();
          expect(screen.queryByRole('alert')).not.toBeInTheDocument();
          expect(heading()).toHaveTextContent(/Saving your choices|Getting your shop ready/);
          expect(versionOf('undo')).toHaveLength(1);
          await tick(5_000);
          expect(heading()).toHaveTextContent('Getting your shop ready.');
          expect(undoButton()).toBeNull();
        });
      }

      it('another window undid it first: re-reads, opens the read-back it left, says so in one line, and does not undo again', async () => {
        await approveFromReadback();
        // The other window's undo, then its re-approval and undo again: this screen's version is two behind.
        current = editableAt(current.version + 1);
        world.status = statusNow();
        fireEvent.click(undoButton()!);
        await settle();
        expect(versionOf('undo')).toHaveLength(1);
        expect(heading()).toHaveTextContent(READBACK);
        expect(screen.getByText('This changed in another window.')).toBeInTheDocument();
        expect(fired('v3_undo')).toHaveLength(0);
      });
    });

    describe('Try again', () => {
      it('posts the version the status block holds, and after a retry of the whole set offers Undo again, posting v + 1', async () => {
        await openOn(approvedAt(4), { execution: 'failed', recovery: 'reset', undoable: false });
        expect(heading()).toHaveTextContent("Something didn't save.");
        fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
        await settle();
        expect(versionOf('retry')).toEqual([4]);
        expect(fired('v3_retry')).toEqual([[ 'v3_retry', expect.anything(), { retried_count: 2, undoable: true } ]]);
        // A fresh window for the whole set: the saving screen, with Undo.
        expect(heading()).toHaveTextContent('Saving your choices.');
        fireEvent.click(undoButton()!);
        await settle();
        expect(versionOf('undo')).toEqual([5]);
        expect(heading()).toHaveTextContent(READBACK);
      });

      it('after a retry of the whole set, the window closes by itself: the poll that says so drops Undo', async () => {
        await openOn(approvedAt(4), { execution: 'failed', recovery: 'reset' });
        fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
        await settle();
        expect(undoButton()).not.toBeNull();
        await tick(2_000);
        // 4 s after the retry the hint (a second early) says no; the next poll carries it.
        world.status = statusNow({ execution: 'pending', undoable: false });
        await tick(1_000);
        expect(undoButton()).toBeNull();
        expect(versionOf('undo')).toEqual([]);
      });

      it('after a retry of only the failed change, offers no Undo and waits, then moves on once both are live', async () => {
        await openOn(approvedAt(4), { execution: 'failed', recovery: 'settings' }, {
          'POST /api/onboarding/draft/retry': () => {
            current = approvedAt(5);
            world.status = statusNow({ execution: 'executing', undoable: false });
            return json(200, { draft: current, retriedProposalIds: [IDS[1]], undoable: false });
          },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
        await settle();
        expect(undoButton()).toBeNull();
        expect(heading()).toHaveTextContent('Getting your shop ready.');
        expect(within(document.querySelector('header') as HTMLElement).getByText('Saving')).toBeInTheDocument();
        world.status = statusNow({ execution: 'executed', undoable: false }, 'billing');
        await nextPoll();
        expect(heading()).toHaveTextContent(/start your free trial/);
      });

      it('offers Start over beside Try again only while the reset can run', async () => {
        const view = await openOn(approvedAt(4), { execution: 'failed', recovery: 'reset' });
        expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Start over' })).toBeInTheDocument();
        expectAllTapTargets(view.container, 'failed, with Start over');
        expectPlainWords();
        view.unmount();

        _resetOnboardingStatusCacheForTests();
        await openOn(approvedAt(4), { execution: 'failed', recovery: 'settings' });
        expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Start over' })).not.toBeInTheDocument();
      });

      it('answered "not safe to retry" (the sibling was taken back from the inbox), re-reads and shows Start over, and does not retry again', async () => {
        await openOn(approvedAt(4), { execution: 'failed', recovery: 'reset' }, {
          'POST /api/onboarding/draft/retry': () => {
            world.status = statusNow({ execution: 'stopped', recovery: 'reset', undoable: false });
            return conflict('DRAFT_RETRY_UNSAFE: Retrying could leave your setup half saved.');
          },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
        await settle();
        expect(heading()).toHaveTextContent('Part of your setup was taken back.');
        expect(screen.getByRole('button', { name: 'Start over' })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
        expect(versionOf('retry')).toHaveLength(1);
      });

      it('another window retried first: a poll replaces the version the screen holds, so Start over posts the new one', async () => {
        await openOn(approvedAt(4), { execution: 'failed', recovery: 'reset' });
        // The other window's retry moved the draft on, and that retry failed again.
        current = approvedAt(5);
        world.status = statusNow({ execution: 'failed', recovery: 'reset' });
        await nextPoll();
        fireEvent.click(screen.getByRole('button', { name: 'Start over' }));
        await settle();
        expect(versionOf('reset')).toEqual([5]);
        expect(heading()).toHaveTextContent(READBACK);
      });

      it('a stale version answers "changed in another window": the screen follows the status and says so, without trying again', async () => {
        await openOn(approvedAt(4), { execution: 'failed', recovery: 'reset' }, {
          'POST /api/onboarding/draft/retry': () => {
            // Another window's retry landed first and is now saving.
            current = approvedAt(5);
            world.status = statusNow({ execution: 'pending', undoable: false });
            return conflict('VERSION_CONFLICT: expected 4, found 5; re-read the draft');
          },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
        await settle();
        expect(versionOf('retry')).toHaveLength(1);
        expect(heading()).toHaveTextContent('Getting your shop ready.');
        expect(screen.getByText('This changed in another window.')).toBeInTheDocument();
        expect(fired('v3_retry')).toHaveLength(0);
      });
    });

    describe('Start over and Settings', () => {
      it('a stopped set that can start over: Start over posts the version and lands on the read-back with the answers intact', async () => {
        const { container } = await openOn(approvedAt(6), { execution: 'stopped', recovery: 'reset' });
        expect(heading()).toHaveTextContent('Part of your setup was taken back.');
        expect(screen.getByText(/Start over to set it up again/)).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
        expect(screen.queryByRole('link', { name: /Settings/ })).not.toBeInTheDocument();
        expectAllTapTargets(container, 'stopped, with Start over');
        expectPlainWords();

        fireEvent.click(screen.getByRole('button', { name: 'Start over' }));
        await settle();
        expect(versionOf('reset')).toEqual([6]);
        expect(heading()).toHaveTextContent(READBACK);
        expect(screen.getByText(OWN_GREETING)).toBeInTheDocument();
        expect(fired('v3_reset')).toHaveLength(1);
      });

      it('a stopped set part of which went through: points at Settings and never offers Start over', async () => {
        const { container } = await openOn(approvedAt(6), { execution: 'stopped', recovery: 'settings' });
        expect(heading()).toHaveTextContent('Part of your setup already went through.');
        const settings = screen.getByRole('link', { name: 'Finish in Settings' });
        expect(settings).toHaveAttribute('href', '/settings');
        expect(screen.queryByRole('button', { name: 'Start over' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
        expectAllTapTargets(container, 'stopped, Settings');
        expectPlainWords();
        await tick(10_000);
        expect(versionOf('reset')).toEqual([]);
      });

      for (const [name, refusal] of [
        ['part of it is already saved', conflict("DRAFT_RESET_REFUSED: Part of your setup is already saved, so it can't start over from here.", { reason: 'applied', statuses: ['executed', 'undone'] })],
        ['its window closed', conflict("UNDO_WINDOW_CLOSED: It's too late to start over.")],
      ] as const) {
        it(`a Start over refused because ${name} swaps in the Settings copy, even while a cached status still offers it, and never a second Start over`, async () => {
          await openOn(approvedAt(6), { execution: 'stopped', recovery: 'reset' }, {
            // The server's status still says reset for a moment (its hint runs a second early only one way).
            'POST /api/onboarding/draft/reset': () => refusal.clone(),
          });
          fireEvent.click(screen.getByRole('button', { name: 'Start over' }));
          await settle();
          expect(heading()).toHaveTextContent('Part of your setup already went through.');
          expect(screen.getByRole('link', { name: 'Finish in Settings' })).toBeInTheDocument();
          expect(screen.queryByRole('button', { name: 'Start over' })).not.toBeInTheDocument();
          await nextPoll();
          expect(screen.queryByRole('button', { name: 'Start over' })).not.toBeInTheDocument();
          expect(versionOf('reset')).toHaveLength(1);
        });
      }

      it('a Start over refused because part of it is being saved right now waits, then follows the status', async () => {
        await openOn(approvedAt(6), { execution: 'stopped', recovery: 'reset' }, {
          'POST /api/onboarding/draft/reset': () =>
            conflict("DRAFT_RESET_REFUSED: Part of your setup is being saved right now, so it can't start over yet.", { reason: 'executing', statuses: ['executing', 'undone'] }),
        });
        fireEvent.click(screen.getByRole('button', { name: 'Start over' }));
        await settle();
        expect(heading()).toHaveTextContent('Getting your shop ready.');
        expect(versionOf('reset')).toHaveLength(1);
        // It landed: the next poll says part of the setup went through.
        world.status = statusNow({ execution: 'stopped', recovery: 'settings' });
        await nextPoll();
        expect(heading()).toHaveTextContent('Part of your setup already went through.');
        expect(versionOf('reset')).toHaveLength(1);
      });

      it('a Start over from a stale tab ("changed in another window") follows the status and says so, without starting over again', async () => {
        await openOn(approvedAt(6), { execution: 'stopped', recovery: 'reset' }, {
          'POST /api/onboarding/draft/reset': () => {
            // The other window already started over and approved again.
            current = approvedAt(8);
            world.status = statusNow({ execution: 'pending', undoable: false });
            return conflict('VERSION_CONFLICT: expected 6, found 8; re-read the draft');
          },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Start over' }));
        await settle();
        expect(versionOf('reset')).toHaveLength(1);
        expect(heading()).toHaveTextContent('Getting your shop ready.');
        expect(screen.getByText('This changed in another window.')).toBeInTheDocument();
        expect(fired('v3_reset')).toHaveLength(0);
      });
    });
  });

  it('walks the trial, the number, the voice and the test call as the status moves on, and hands off when the owner opens for business', async () => {
    stub(statusAt('billing'));
    const { container } = renderShell();
    await settle();

    // The trial: the real plans, nothing to escape to (a card is what pays for the number).
    expect(heading()).toHaveTextContent('Last thing before your number: start your free trial.');
    expect(screen.getAllByRole('radio')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Start my free trial' })).toBeInTheDocument();
    expectFrame(3, 70, 'Saved');
    expect(headerEscape()).toBeNull();
    expectAllTapTargets(container, 'the trial');
    expect(fired('v3_trial_viewed')).toEqual([['v3_trial_viewed', expect.objectContaining({ tenantId: statusAt('billing').tenantId })]]);

    // The trial is on: the number is being claimed.
    world.status = statusAt('phone', { phone: { status: 'current', metadata: { lineState: 'claiming' } } });
    await nextPoll();
    expect(heading()).toHaveTextContent('Getting your number.');
    expectFrame(2, 80, 'Your number');
    expect(headerEscape()).toBeNull();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    expect(fired('v3_number_viewed')).toHaveLength(1);
    expect(fired('v3_number_ready')).toHaveLength(0);

    // The number is known, and a moment later the line is fully ready: the voice is next.
    world.status = statusAt('phone', { phone: { status: 'current', metadata: { phoneNumber: NUMBER } } });
    await nextPoll();
    expect(heading()).toHaveTextContent("Here's your number.");
    expect(screen.getByText('(216) 555-0180')).toBeInTheDocument();
    expect(fired('v3_number_ready')).toHaveLength(1);

    world.status = statusAt('ai_check', { ...phoneDone, ai_check: { status: 'current', metadata: { verifying: true } } });
    await nextPoll();
    expect(heading()).toHaveTextContent('Getting my voice ready.');
    expectFrame(1, 90, 'Almost open');
    expect(headerEscape()).toBeNull();
    expect(fired('v3_test_call_viewed')).toHaveLength(0);

    // The voice is ready: now the owner calls.
    world.status = statusAt('test_call', phoneDone);
    await nextPoll();
    expect(heading()).toHaveTextContent('Now you call me.');
    expect(screen.getByRole('link', { name: '(216) 555-0180' })).toHaveAttribute('href', `tel:${NUMBER}`);
    expectFrame(1, 90, 'Almost open');
    expect(headerEscape()).toHaveTextContent("I'll test later");
    expectAllTapTargets(container, 'the test call');
    expect(fired('v3_test_call_viewed')).toHaveLength(1);
    expect(fired('test_call_succeeded')).toHaveLength(0);

    // The call comes in: setup is complete, and the owner stays for the one tap that opens the phones.
    world.status = statusAt(null, phoneDone);
    await nextPoll();
    expect(heading()).toHaveTextContent('I got your call. Ready to open for business?');
    expectFrame(1, 100, 'Ready to open');
    expect(headerEscape()).toBeNull();
    expect(where()).toBe('/onboarding');
    expect(fired('test_call_succeeded')).toEqual([['test_call_succeeded', expect.objectContaining({ tenantId: statusAt('billing').tenantId })]]);

    // Setup finished here, so the funnel's completion step is recorded: once, with the phones still closed.
    expect(track.track.mock.calls.filter(([e]) => e === 'onboarding_completed')).toEqual([['onboarding_completed', { voiceAgentLive: false }]]);
    expect(fired('wizard_completed')).toEqual([
      ['wizard_completed', { tenantId: statusAt('billing').tenantId, userId: undefined }, { voice_agent_live: false }],
    ]);

    // Opening for business asks the API for the status again, so what the next page reads is not the cached one from before the tap.
    const statusRequests = () => requests.filter((r) => r === 'GET /api/onboarding/status').length;
    const before = statusRequests();
    fireEvent.click(screen.getByRole('button', { name: "That's right. Open for business." }));
    await settle();
    expect(requests).toContain('POST /api/voice/go-live');
    expect(statusRequests()).toBeGreaterThan(before);
    expect(screen.getByText('home page')).toBeInTheDocument();
    expect(track.track).toHaveBeenCalledWith('voice_agent_turned_on');
    expect(fired('wizard_completed')).toHaveLength(1);

    // Once each, however many polls they were on screen for.
    for (const event of ['v3_trial_viewed', 'v3_number_viewed', 'v3_number_ready', 'v3_test_call_viewed', 'test_call_succeeded']) {
      expect(fired(event), event).toHaveLength(1);
    }
  });

  it('never lowers the line or raises the minutes when a late status goes back a step', async () => {
    stub(statusAt('phone', { phone: { status: 'current', metadata: { lineState: 'claiming' } } }));
    renderShell();
    await settle();
    expectFrame(2, 80, 'Your number');
    world.status = statusAt('billing');
    await nextPoll();
    expect(heading()).toHaveTextContent(/start your free trial/);
    expect(progress()).toBe('80');
    expect(screen.getByText('About 2 minutes left')).toBeInTheDocument();
    expect(screen.queryByText('About 3 minutes left')).not.toBeInTheDocument();
  });

  describe('when the server opens the phones itself as the test call ends', () => {
    it('still shows "I got your call", says the phones are open, and hands off only on the tap', async () => {
      stub(statusAt('test_call', phoneDone));
      renderShell();
      await settle();
      expect(heading()).toHaveTextContent('Now you call me.');

      // The call ends: the poll that says it was heard also says the phones are open.
      world.status = { ...statusAt(null, phoneDone), voiceAgentLive: true };
      await nextPoll();
      expect(heading()).toHaveTextContent("I got your call. You're open for business.");
      expectFrame(1, 100, 'Ready to open');
      expect(where()).toBe('/onboarding');
      expect(fired('test_call_succeeded')).toHaveLength(1);

      // It stays put on later polls, however long the owner takes.
      await nextPoll();
      await nextPoll();
      expect(heading()).toHaveTextContent("I got your call. You're open for business.");

      fireEvent.click(screen.getByRole('button', { name: 'Take me home' }));
      await settle();
      expect(screen.getByText('home page')).toBeInTheDocument();
      // The server did it, so there is nothing to ask it to do again, and nothing the owner turned on.
      expect(requests).not.toContain('POST /api/voice/go-live');
      expect(track.track).not.toHaveBeenCalledWith('voice_agent_turned_on');
      expect(track.track).toHaveBeenCalledWith('onboarding_completed', { voiceAgentLive: true });
      expect(fired('wizard_completed').map(([, , extra]) => extra)).toEqual([{ voice_agent_live: true }]);
    });

    it('goes on to offer the button when the poll lands between the server\'s two writes, and the phones open a poll later', async () => {
      stub(statusAt('test_call', phoneDone));
      renderShell();
      await settle();
      world.status = statusAt(null, phoneDone);
      await nextPoll();
      expect(screen.getByRole('button', { name: "That's right. Open for business." })).toBeInTheDocument();
      world.status = { ...world.status, voiceAgentLive: true };
      await nextPoll();
      expect(heading()).toHaveTextContent("I got your call. You're open for business.");
      expect(where()).toBe('/onboarding');
    });
  });

  describe('"I\'ll test later"', () => {
    it('skips the test call through the real route, then tells the owner answering is off and offers to open anyway', async () => {
      stub(statusAt('test_call', phoneDone));
      renderShell();
      await settle();
      expect(heading()).toHaveTextContent('Now you call me.');

      fireEvent.click(screen.getByRole('button', { name: "I'll test later" }));
      await settle();

      expect(requests).toContain('POST /api/onboarding/test-call/skip');
      expect(heading()).toHaveTextContent('No problem. Ready to open for business anyway?');
      expect(screen.getByText(/I send every caller to voicemail/)).toBeInTheDocument();
      expect(headerEscape()).toBeNull();
      expect(where()).toBe('/onboarding');
      expect(fired('test_call_succeeded')).toHaveLength(0);
      // Setup is finished, and that is recorded, even though the call was never heard.
      expect(fired('wizard_completed')).toHaveLength(1);

      fireEvent.click(screen.getByRole('button', { name: "That's right. Open for business." }));
      await settle();
      expect(requests).toContain('POST /api/voice/go-live');
      expect(screen.getByText('home page')).toBeInTheDocument();
      expect(track.track).toHaveBeenCalledWith('voice_agent_turned_on');
    });

    it('lets the owner leave answering off: "Not yet" hands off without opening anything', async () => {
      stub(statusAt('test_call', phoneDone));
      renderShell();
      await settle();
      fireEvent.click(screen.getByRole('button', { name: "I'll test later" }));
      await settle();
      fireEvent.click(screen.getByRole('button', { name: 'Not yet' }));
      await settle();
      expect(screen.getByText('home page')).toBeInTheDocument();
      expect(requests).not.toContain('POST /api/voice/go-live');
    });

    it('hands off straight away when the phones were already open', async () => {
      stub(statusAt('test_call', phoneDone), {
        'POST /api/onboarding/test-call/skip': () => {
          world.status = { ...statusAt(null, { ...phoneDone, test_call: { status: 'skipped' } }), voiceAgentLive: true };
          return json(200, { ok: true });
        },
      });
      renderShell();
      await settle();
      fireEvent.click(screen.getByRole('button', { name: "I'll test later" }));
      await settle();
      expect(screen.getByText('home page')).toBeInTheDocument();
      expect(requests).not.toContain('POST /api/voice/go-live');
    });

    it('shows the skip is working while the request is out, and sends it once however often it is tapped', async () => {
      let finish: (r: Response) => void = () => {};
      stub(statusAt('test_call', phoneDone), {
        'POST /api/onboarding/test-call/skip': () =>
          new Promise<Response>((resolve) => {
            finish = (r) => {
              world.status = statusAt(null, { ...phoneDone, test_call: { status: 'skipped' } });
              resolve(r);
            };
          }) as unknown as Response,
      });
      renderShell();
      await settle();
      fireEvent.click(screen.getByRole('button', { name: "I'll test later" }));
      await settle();
      const busy = screen.getByRole('button', { name: 'One moment…' });
      expect(busy).toBeDisabled();
      expect(busy).toHaveAttribute('aria-busy', 'true');
      fireEvent.click(busy);
      expect(requests.filter((r) => r === 'POST /api/onboarding/test-call/skip')).toHaveLength(1);

      finish(json(200, { ok: true }));
      await settle();
      expect(heading()).toHaveTextContent('No problem. Ready to open for business anyway?');
    });

    it('stays on the call and says so when the skip does not go through', async () => {
      stub(statusAt('test_call', phoneDone), { 'POST /api/onboarding/test-call/skip': () => json(500, { error: 'INTERNAL', message: 'boom' }) });
      renderShell();
      await settle();
      fireEvent.click(screen.getByRole('button', { name: "I'll test later" }));
      await settle();
      expect(screen.getByRole('alert')).toHaveTextContent("That didn't go through. Wait a minute and try again.");
      expect(heading()).toHaveTextContent('Now you call me.');
      expect(where()).toBe('/onboarding');
      // The button is back, not stuck on "One moment…".
      expect(screen.getByRole('button', { name: "I'll test later" })).toBeEnabled();
      expect(fired('wizard_completed')).toHaveLength(0);
    });
  });

  describe('coming back from the payment page', () => {
    it('after paying, clears the address, asks for the status again and says the trial is being confirmed', async () => {
      stub(statusAt('billing'));
      renderShell('/onboarding?billing=ok');
      await settle();
      expect(where()).toBe('/onboarding');
      expect(screen.getByText("Thanks. I'm confirming your trial.")).toBeInTheDocument();
      expect(heading()).toHaveTextContent(/start your free trial/);
      expect(requests).not.toContain('POST /api/onboarding/billing/cancel');

      // The payment page tells the API a few seconds later; the next poll moves the owner on.
      world.status = statusAt('phone', { phone: { status: 'current', metadata: { lineState: 'claiming' } } });
      await nextPoll();
      expect(heading()).toHaveTextContent('Getting your number.');
      expect(screen.queryByText("Thanks. I'm confirming your trial.")).not.toBeInTheDocument();
    });

    it('after backing out, releases the pending checkout and says the trial has not started', async () => {
      stub(statusAt('billing'));
      renderShell('/onboarding?billing=cancel');
      await settle();
      expect(requests).toContain('POST /api/onboarding/billing/cancel');
      expect(where()).toBe('/onboarding');
      expect(screen.getByText("No problem. Your trial hasn't started. Start it whenever you're ready.")).toBeInTheDocument();
      expect(heading()).toHaveTextContent(/start your free trial/);
    });
  });

  describe('a setup that is already finished', () => {
    it('goes straight home on first sight, reporting nothing the owner did not do', async () => {
      stub(statusAt(null, phoneDone));
      renderShell();
      await settle();
      expect(screen.getByText('home page')).toBeInTheDocument();
      for (const event of ['v3_test_call_viewed', 'test_call_succeeded', 'v3_number_ready', 'v3_number_viewed', 'v3_trial_viewed', 'wizard_completed']) {
        expect(fired(event), event).toHaveLength(0);
      }
      expect(track.track).not.toHaveBeenCalledWith('onboarding_completed', expect.anything());
    });

    it('does not report the number as new to a visit that picks up at the test call', async () => {
      stub(statusAt('test_call', phoneDone));
      renderShell();
      await settle();
      expect(heading()).toHaveTextContent('Now you call me.');
      expect(fired('v3_number_ready')).toHaveLength(0);
      expect(fired('v3_test_call_viewed')).toHaveLength(1);
    });
  });

  describe('the old sidebar shell', () => {
    it('is reached only by an explicit re-run, even for a shop that was just saved', async () => {
      stub(statusAt('billing'));
      renderShell('/onboarding?rerun=1');
      await settle();
      expect(screen.getByText('v2 shell')).toBeInTheDocument();
      expect(requests).toEqual([]);
    });

    it('is never the next screen on the ordinary path, at any step after the shop is saved', async () => {
      for (const step of ['identity', 'billing', 'phone', 'ai_check', 'test_call'] as const) {
        _resetOnboardingStatusCacheForTests();
        stub(statusAt(step, step === 'test_call' ? phoneDone : undefined));
        const view = renderShell();
        await settle();
        expect(screen.queryByText('v2 shell'), step).not.toBeInTheDocument();
        view.unmount();
      }
    });
  });
});
