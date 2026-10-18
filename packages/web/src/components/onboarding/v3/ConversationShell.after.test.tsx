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
    it('says it is getting the shop ready, then that it is still here, then admits it is slow and offers Try again', async () => {
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
      expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();

      await tick(15_999);
      expect(screen.queryByText('This is taking longer than usual.')).not.toBeInTheDocument();
      await tick(1);
      expect(screen.getByRole('status')).toHaveTextContent('This is taking longer than usual.');
      expect(screen.queryByText('Still with you.')).not.toBeInTheDocument();
      expectAllTapTargets(container, 'the slow wait');

      // Try again asks the API again, and the shop is live: the trial takes over.
      world.status = statusAt('billing');
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
      await settle();
      expect(heading()).toHaveTextContent(/start your free trial/);
      expect(requests.filter((r) => r === 'GET /api/onboarding/status').length).toBeGreaterThan(1);
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

    fireEvent.click(screen.getByRole('button', { name: "That's right. Open for business." }));
    await settle();
    expect(requests).toContain('POST /api/voice/go-live');
    expect(screen.getByText('home page')).toBeInTheDocument();
    expect(track.track).toHaveBeenCalledWith('voice_agent_turned_on');

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
  });

  describe('"I\'ll test later"', () => {
    it('skips the test call through the real route and hands off, without saying the call was heard', async () => {
      stub(statusAt('test_call', phoneDone));
      renderShell();
      await settle();
      expect(heading()).toHaveTextContent('Now you call me.');

      fireEvent.click(screen.getByRole('button', { name: "I'll test later" }));
      await settle();

      expect(requests).toContain('POST /api/onboarding/test-call/skip');
      expect(screen.getByText('home page')).toBeInTheDocument();
      expect(fired('test_call_succeeded')).toHaveLength(0);
      expect(requests).not.toContain('POST /api/voice/go-live');
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
      for (const event of ['v3_test_call_viewed', 'test_call_succeeded', 'v3_number_ready', 'v3_number_viewed', 'v3_trial_viewed']) {
        expect(fired(event), event).toHaveLength(0);
      }
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
