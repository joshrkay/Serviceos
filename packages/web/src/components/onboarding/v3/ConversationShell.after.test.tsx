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
import { plumbingCleDraft } from './__fixtures__';
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
let routes: Record<string, (() => Response | Promise<Response>) | undefined>;

function stub(status: OnboardingStatusResponse, extra: typeof routes = {}) {
  world = { status };
  requests = [];
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
      const handler = routes[call];
      if (!handler) throw new Error(`unexpected request ${call}`);
      return Promise.resolve(handler());
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
      expect(heading()).toHaveTextContent('One of your changes was undone.');
      expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    });

    it('on a 409 where the status still says failed, or any other error, shows one plain line and lets the owner tap again', async () => {
      stub(savedAs('failed'), {
        'POST /api/onboarding/draft/retry': () => json(409, { error: 'CONFLICT', message: 'DRAFT_RETRY_UNSAFE: not safe to retry' }),
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
      expect(heading()).toHaveTextContent('One of your changes was undone.');
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

    it('says one change was undone and offers the step-by-step setup as the only action, never a retry', async () => {
      stub(savedAs('stopped'));
      const { container } = renderShell();
      await settle();

      expect(heading()).toHaveTextContent('One of your changes was undone.');
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
