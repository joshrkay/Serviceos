/**
 * The number turn against the real useApiClient with `fetch` stubbed: first on
 * its own, then through the real shell, where the onboarding status poll drives
 * it (the API's failure code decides whether it looks for another number).
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import type { OnboardingDraft } from '@ai-service-os/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetOnboardingStatusCacheForTests } from '../../../hooks/useOnboardingStatus';
import type { OnboardingStatusResponse, OnboardingStep, PhoneFailureCode } from '../../../types/onboarding';
import { expectAllTapTargets } from '../../../test-utils/tap-target';
import { plumbingCleDraft } from './__fixtures__';
import { json, statusAt } from './__fixtures__/after';
import { NumberTurn } from './NumberTurn';
import { TurnFrame } from './TurnFrame';

vi.mock('../../../lib/analytics', () => ({ trackFunnel: vi.fn(), track: vi.fn() }));
vi.mock('../v2/OnboardingShell', () => ({ OnboardingShell: () => <div>v2 shell</div> }));

import { ConversationShell } from './ConversationShell';

let retry: () => Response | Promise<Response>;
let requests: string[];

function stub() {
  requests = [];
  retry = () => json(200, { ok: true, enqueued: true });
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const call = `${init?.method ?? 'GET'} ${String(input)}`;
      requests.push(call);
      if (call === 'POST /api/onboarding/phone/retry') return Promise.resolve(retry());
      throw new Error(`unexpected request ${call}`);
    }),
  );
}

const phone = (over: Partial<OnboardingStep> = {}): OnboardingStep => ({ id: 'phone', status: 'current', ...over });

function renderTurn(step: OnboardingStep | undefined, onChanged = vi.fn()) {
  const view = render(
    <TurnFrame minutesLeft={2} progress={0.8} statusLabel="Your number">
      <NumberTurn step={step} onChanged={onChanged} />
    </TurnFrame>,
  );
  return { ...view, onChanged };
}

describe('NumberTurn', () => {
  beforeEach(stub);
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  describe('while the number is on its way', () => {
    it('says it is getting it, with nothing to tap and nothing sent', () => {
      const { container } = renderTurn(phone({ metadata: { lineState: 'setting_up' } }));
      expect(screen.getByRole('heading', { level: 1, name: 'Getting your number.' })).toBeInTheDocument();
      expect(screen.getByText('A local number usually takes about 30 seconds.')).toBeInTheDocument();
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
      expect(requests).toEqual([]);
      expectAllTapTargets(container, 'getting the number');
    });

    it('names the number being claimed, formatted', () => {
      renderTurn(phone({ metadata: { lineState: 'claiming', pendingNumber: '+12165550199' } }));
      expect(screen.getByText('Claiming (216) 555-0199.')).toBeInTheDocument();
    });

    it('is quiet at first, then "Still with you.", and offers a refresh only after thirty seconds', () => {
      vi.useFakeTimers();
      const { onChanged } = renderTurn(phone());
      act(() => void vi.advanceTimersByTime(4_000));
      expect(screen.getByText('Still with you.')).toBeInTheDocument();
      act(() => void vi.advanceTimersByTime(25_999));
      expect(screen.queryByRole('button', { name: 'Check again' })).not.toBeInTheDocument();
      act(() => void vi.advanceTimersByTime(1));
      expect(screen.getByText('This is taking longer than usual.')).toBeInTheDocument();
      // Nothing is sent from here, so it is not called "Try again".
      expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
      screen.getByRole('button', { name: 'Check again' }).click();
      // It only checks the status again; nothing is bought by waiting.
      expect(onChanged).toHaveBeenCalledTimes(1);
      expect(requests).toEqual([]);
    });
  });

  describe('when the line is ready and no number is held yet', () => {
    const step = () => phone({ metadata: { lineState: 'awaiting_pick' } });

    it('asks for the number with one tap, because nothing is bought until the owner asks', async () => {
      const { container, onChanged } = renderTurn(step());
      expect(screen.getByRole('heading', { level: 1, name: "Let's get your number." })).toBeInTheDocument();
      expect(screen.getByText("I'll pick a local one near your business.")).toBeInTheDocument();
      expectAllTapTargets(container, 'asking for the number');

      await userEvent.click(screen.getByRole('button', { name: 'Get my number' }));
      await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
      expect(requests).toEqual(['POST /api/onboarding/phone/retry']);
    });

    it('does not send a second request on a double tap', async () => {
      let finish: (r: Response) => void = () => {};
      retry = () => new Promise<Response>((resolve) => {
        finish = resolve;
      });
      const { onChanged } = renderTurn(step());
      await userEvent.dblClick(screen.getByRole('button', { name: 'Get my number' }));
      expect(requests).toHaveLength(1);
      finish(json(200, { ok: true }));
      await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    });

    it('says the trial comes first when the API refuses a number before checkout', async () => {
      retry = () => json(409, { error: 'PHONE_BILLING_REQUIRED', message: 'Complete trial checkout before provisioning a phone number.' });
      const { onChanged } = renderTurn(step());
      await userEvent.click(screen.getByRole('button', { name: 'Get my number' }));
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('Your trial has to start before I can get you a number.');
      expect(alert.textContent).not.toMatch(/provisioning/i);
      expect(onChanged).not.toHaveBeenCalled();
    });

    it('says so when the connection drops, and lets the owner tap again', async () => {
      retry = () => Promise.reject(new TypeError('Failed to fetch'));
      renderTurn(step());
      await userEvent.click(screen.getByRole('button', { name: 'Get my number' }));
      expect(await screen.findByRole('alert')).toHaveTextContent("I couldn't reach the server. Check your connection and try again.");
      retry = () => json(200, { ok: true });
      await userEvent.click(screen.getByRole('button', { name: 'Get my number' }));
      await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
      expect(requests).toHaveLength(2);
    });
  });

  describe('when the number is known', () => {
    it('shows it formatted, in Rivet\'s words, with nothing to tap', () => {
      const { container } = renderTurn(phone({ metadata: { phoneNumber: '+12165550180', lineState: 'active' } }));
      expect(screen.getByRole('heading', { level: 1, name: "Here's your number." })).toBeInTheDocument();
      expect(screen.getByText('(216) 555-0180')).toBeInTheDocument();
      expect(screen.getByText("I'm finishing the last details, then you can call it.")).toBeInTheDocument();
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
      expectAllTapTargets(container, 'number ready');
    });
  });

  describe('when it could not get one', () => {
    it.each([
      ['area_code_unavailable', "There were no free numbers where I looked. Pick a different area code and I'll look there."],
      ['credentials_missing', "That's on our side, not yours. Please contact support and we'll sort it out."],
      ['provider_error', "I couldn't reach the phone company just now. Try again in a minute."],
      ['unknown', 'Something went wrong getting your number. Try again.'],
    ] as const)('says what %s means, without the vendor or the mechanism', (code, line) => {
      renderTurn(phone({ status: 'error', failureCode: code, blockers: ['twilio_provisioning_failed'] }));
      expect(screen.getByText(line)).toBeInTheDocument();
      expect(document.body.textContent).not.toMatch(/twilio|provisioning|_/i);
    });

    it.each([
      ['twilio_provisioning_failed', "I couldn't get you a number this time. Try again and I'll look for another."],
      ['twilio_credentials_missing', "I can't set up phone numbers on your account yet. Please contact support."],
      ['area_code_unavailable', "There were no free numbers in your area code. Try again and I'll look in the next one."],
      ['rate_limited', "I've tried a few times already. Give it a minute, then try again."],
    ])('falls back to what %s means when an older server sends no code, with Try again', (blocker, line) => {
      renderTurn(phone({ status: 'error', blockers: [blocker] }));
      expect(screen.getByRole('heading', { level: 1, name: "I couldn't get your number yet." })).toBeInTheDocument();
      expect(screen.getByText(line)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
      expect(document.body.textContent).not.toMatch(/twilio|provisioning|_/i);
    });

    it('asks the API again with "Try again" and checks the status when it was accepted', async () => {
      const { container, onChanged } = renderTurn(phone({ status: 'error', failureCode: 'provider_error', blockers: ['twilio_provider_error'] }));
      expectAllTapTargets(container, 'number error');
      await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
      await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
      expect(requests).toEqual(['POST /api/onboarding/phone/retry']);
    });

    it('keeps the failure on screen and says why when trying again is refused', async () => {
      retry = () => json(500, { error: 'PHONE_RETRY_FAILED', message: 'connect ECONNREFUSED 10.0.0.4:5432' });
      const { onChanged } = renderTurn(phone({ status: 'error', blockers: ['rate_limited'] }));
      await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent("I couldn't do that just now. Wait a minute and try again.");
      expect(alert.textContent).not.toMatch(/ECONNREFUSED/);
      expect(screen.getByText("I've tried a few times already. Give it a minute, then try again.")).toBeInTheDocument();
      expect(onChanged).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// Through the shell: the status poll drives the turn.
// ---------------------------------------------------------------------------

const approved: OnboardingDraft = {
  ...plumbingCleDraft,
  status: 'approved',
  version: 2,
  proposalIds: ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'],
  approvedAt: '2026-10-18T10:05:00.000Z',
};

/** Numbers as POST /api/onboarding/phone/available returns them (searchAvailableNumbers). */
const cand = (phoneNumber: string) => ({ phoneNumber, locality: 'Cleveland', region: 'OH' });
const FIRST = '+12165550111';
const SECOND = '+12165550122';
const THIRD = '+12165550133';

const awaitingPick = () => statusAt('phone', { phone: { status: 'current', metadata: { lineState: 'awaiting_pick' } } });
const claimingAs = (n: string) => statusAt('phone', { phone: { status: 'current', metadata: { lineState: 'claiming', pendingNumber: n } } });
/** What derive-status.ts reports once the worker recorded a failure: the code, its blocker first, never the text. */
const failedWith = (failureCode: PhoneFailureCode) => {
  const blocker: Record<PhoneFailureCode, string | null> = {
    area_code_unavailable: 'area_code_unavailable',
    credentials_missing: 'twilio_credentials_missing',
    provider_error: 'twilio_provider_error',
    unknown: null,
  };
  const specific = blocker[failureCode];
  return statusAt('phone', {
    phone: { status: 'error', failureCode, blockers: specific ? [specific, 'twilio_provisioning_failed'] : ['twilio_provisioning_failed'] },
  });
};

describe('NumberTurn through the shell, keyed on the failure code', () => {
  let world: { status: OnboardingStatusResponse; available: Record<string, Array<ReturnType<typeof cand>>> };
  let calls: Array<{ call: string; body: unknown }>;

  function stubShell(status: OnboardingStatusResponse, available: Record<string, Array<ReturnType<typeof cand>>> = {}) {
    world = { status, available };
    calls = [];
    const routes: Partial<Record<string, (body: Record<string, unknown>) => Response>> = {
      'GET /api/onboarding/status': () => json(200, world.status),
      'GET /api/onboarding/draft': () => json(200, { draft: approved }),
      'POST /api/onboarding/phone/available': (body) => json(200, { numbers: world.available[String(body.areaCode)] ?? [] }),
      // Like the real route: the pick is marked pending, so the next status is "claiming" until the worker runs.
      'POST /api/onboarding/phone/claim': (body) => {
        world.status = claimingAs(String(body.phoneNumber));
        return json(200, { ok: true, enqueued: true, phoneNumber: body.phoneNumber });
      },
      'POST /api/onboarding/phone/retry': () => {
        world.status = statusAt('phone', { phone: { status: 'current', metadata: { lineState: 'claiming' } } });
        return json(200, { ok: true, enqueued: true });
      },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const call = `${init?.method ?? 'GET'} ${String(input)}`;
        const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
        calls.push({ call, body });
        const handler = routes[call];
        if (!handler) throw new Error(`unexpected request ${call}`);
        return Promise.resolve(handler(body));
      }),
    );
  }

  const renderShell = () =>
    render(
      <MemoryRouter initialEntries={['/onboarding']}>
        <Routes>
          <Route path="/onboarding" element={<ConversationShell />} />
          <Route path="/" element={<div>home page</div>} />
        </Routes>
      </MemoryRouter>,
    );

  const settle = () =>
    act(async () => {
      for (let i = 0; i < 4; i += 1) await vi.advanceTimersByTimeAsync(0);
    });
  /** The API is polled every three seconds. */
  const nextPoll = () =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
      for (let i = 0; i < 3; i += 1) await vi.advanceTimersByTimeAsync(0);
    });
  const tap = async (name: string) => {
    fireEvent.click(screen.getByRole('button', { name }));
    await settle();
  };
  const searches = () => calls.filter((c) => c.call === 'POST /api/onboarding/phone/available');
  const claims = () => calls.filter((c) => c.call === 'POST /api/onboarding/phone/claim');
  const retries = () => calls.filter((c) => c.call === 'POST /api/onboarding/phone/retry');
  const heading = () => screen.getByRole('heading', { level: 1 });

  /** The owner picks an area code and takes the number Rivet shows: the turn now holds that area code. */
  async function pickAndClaim(areaCode: string, expected: string) {
    await tap('Pick a different area code');
    fireEvent.change(screen.getByLabelText('Area code'), { target: { value: areaCode } });
    await tap('Look for a number');
    expect(screen.getByText(formatted(expected))).toBeInTheDocument();
    await tap('That works');
    expect(claims().at(-1)?.body).toEqual({ phoneNumber: expected });
  }
  const formatted = (n: string) => `(${n.slice(2, 5)}) ${n.slice(5, 8)}-${n.slice(8)}`;

  beforeEach(() => {
    vi.useFakeTimers();
    _resetOnboardingStatusCacheForTests();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('a taken number: looks once in the same area code and offers the next one, buying nothing until "That works"', async () => {
    stubShell(awaitingPick(), { '216': [cand(FIRST), cand(SECOND), cand(THIRD)] });
    const { container } = renderShell();
    await settle();
    expect(heading()).toHaveTextContent("Let's get your number.");

    await pickAndClaim('216', FIRST);
    expect(searches().map((c) => c.body)).toEqual([{ areaCode: '216' }]);
    expect(heading()).toHaveTextContent('Getting your number.');

    // The worker finds the number gone: the next poll says so, with the code.
    world.status = failedWith('area_code_unavailable');
    await nextPoll();
    expect(searches().map((c) => c.body)).toEqual([{ areaCode: '216' }, { areaCode: '216' }]);
    expect(heading()).toHaveTextContent("That one just went. Here's another.");
    // The next one, not the one that just went.
    expect(screen.getByText(formatted(SECOND))).toBeInTheDocument();
    expect(screen.queryByText(formatted(FIRST))).not.toBeInTheDocument();
    expectAllTapTargets(container, 'the replacement offer');

    // It waits for the owner: more polls of the same failure look for nothing and buy nothing.
    await nextPoll();
    await nextPoll();
    expect(searches()).toHaveLength(2);
    expect(claims()).toHaveLength(1);

    // "That works" buys exactly the number shown.
    await tap('That works');
    expect(claims().map((c) => c.body)).toEqual([{ phoneNumber: FIRST }, { phoneNumber: SECOND }]);
    expect(heading()).toHaveTextContent('Getting your number.');

    // That one goes too: it looks again, once, and offers the one after.
    world.status = failedWith('area_code_unavailable');
    await nextPoll();
    expect(searches()).toHaveLength(3);
    expect(searches().at(-1)?.body).toEqual({ areaCode: '216' });
    expect(heading()).toHaveTextContent("That one just went. Here's another.");
    expect(screen.getByText(formatted(THIRD))).toBeInTheDocument();
    await nextPoll();
    expect(searches()).toHaveLength(3);
    expect(claims()).toHaveLength(2);
    expect(retries()).toHaveLength(0);
  });

  it('when the area code has nothing left, asks for a different one, and a typed area code is searched and claimed the same way', async () => {
    stubShell(awaitingPick(), { '216': [cand(FIRST)], '330': [cand('+13305550144')] });
    const { container } = renderShell();
    await settle();
    await pickAndClaim('216', FIRST);

    world.status = failedWith('area_code_unavailable');
    await nextPoll();
    // The only number there was the one that just went.
    expect(heading()).toHaveTextContent('Pick a different area code.');
    expect(screen.getByText('There are no free numbers in 216 right now. Try one nearby.')).toBeInTheDocument();
    expectAllTapTargets(container, 'the area-code form after an empty search');
    expect(screen.getByLabelText('Area code').className).toMatch(/(^|\s)min-h-11(\s|$)/);

    fireEvent.change(screen.getByLabelText('Area code'), { target: { value: '330' } });
    await tap('Look for a number');
    expect(searches().at(-1)?.body).toEqual({ areaCode: '330' });
    expect(screen.getByText('(330) 555-0144')).toBeInTheDocument();
    expect(claims()).toHaveLength(1);
    await tap('That works');
    expect(claims().at(-1)?.body).toEqual({ phoneNumber: '+13305550144' });
  });

  it('a taken number it did not ask for itself (a reload, or a number picked for the owner): asks for the area code instead of guessing one', async () => {
    stubShell(failedWith('area_code_unavailable'), { '216': [cand(FIRST)] });
    renderShell();
    await settle();
    await nextPoll();
    expect(heading()).toHaveTextContent('Pick a different area code.');
    expect(screen.getByText("There were no free numbers where I looked. Pick a different area code and I'll look there.")).toBeInTheDocument();
    expect(searches()).toHaveLength(0);
    expect(retries()).toHaveLength(0);

    fireEvent.change(screen.getByLabelText('Area code'), { target: { value: '216' } });
    await tap('Look for a number');
    expect(searches().map((c) => c.body)).toEqual([{ areaCode: '216' }]);
    await tap('That works');
    expect(claims().map((c) => c.body)).toEqual([{ phoneNumber: FIRST }]);
  });

  it('a problem on our side: its own words, no number action, nothing searched and nothing retried', async () => {
    stubShell(awaitingPick(), { '216': [cand(FIRST), cand(SECOND)] });
    renderShell();
    await settle();
    await pickAndClaim('216', FIRST);

    world.status = failedWith('credentials_missing');
    await nextPoll();
    await nextPoll();
    expect(heading()).toHaveTextContent("I couldn't get your number yet.");
    expect(screen.getByText("That's on our side, not yours. Please contact support and we'll sort it out.")).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(searches()).toHaveLength(1);
    expect(retries()).toHaveLength(0);
    expect(claims()).toHaveLength(1);
  });

  it.each([
    ['provider_error', "I couldn't reach the phone company just now. Try again in a minute."],
    ['unknown', 'Something went wrong getting your number. Try again.'],
  ] as const)('%s: its own words and one Try again, sent only on the owner\'s tap, never a new search or a replacement', async (code, line) => {
    stubShell(awaitingPick(), { '216': [cand(FIRST), cand(SECOND)] });
    const { container } = renderShell();
    await settle();
    await pickAndClaim('216', FIRST);

    world.status = failedWith(code);
    await nextPoll();
    await nextPoll();
    expect(heading()).toHaveTextContent("I couldn't get your number yet.");
    expect(screen.getByText(line)).toBeInTheDocument();
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Try again']);
    expect(screen.queryByText(formatted(SECOND))).not.toBeInTheDocument();
    expect(searches()).toHaveLength(1);
    expect(retries()).toHaveLength(0);
    expectAllTapTargets(container, `${code} with Try again`);

    await tap('Try again');
    expect(retries()).toHaveLength(1);
    expect(searches()).toHaveLength(1);
    expect(claims()).toHaveLength(1);
  });

  it('a number picked for the owner that comes back taken with no area code held opens the area-code form, not a search', async () => {
    stubShell(awaitingPick());
    renderShell();
    await settle();
    await tap('Get my number');
    expect(retries()).toHaveLength(1);
    world.status = failedWith('area_code_unavailable');
    await nextPoll();
    expect(heading()).toHaveTextContent('Pick a different area code.');
    expect(searches()).toHaveLength(0);
  });

  it('a search that cannot run says so plainly and offers no number', async () => {
    stubShell(awaitingPick());
    renderShell();
    await settle();
    // The search route is down (local and hermetic environments have no number search at all).
    vi.mocked(fetch).mockImplementationOnce(() => Promise.resolve(json(503, { error: 'TWILIO_NOT_CONFIGURED', message: 'Phone number search is not available' })));
    await tap('Pick a different area code');
    fireEvent.change(screen.getByLabelText('Area code'), { target: { value: '216' } });
    await tap('Look for a number');
    expect(screen.getByRole('alert')).toHaveTextContent("I can't look up numbers right now. Try again in a minute, or contact support.");
    expect(document.body.textContent).not.toMatch(/twilio|_/i);
    expect(screen.queryByRole('button', { name: 'That works' })).not.toBeInTheDocument();
  });

  it('a refused claim keeps the offer on screen and says why, in plain words', async () => {
    stubShell(awaitingPick(), { '216': [cand(FIRST)] });
    renderShell();
    await settle();
    await tap('Pick a different area code');
    fireEvent.change(screen.getByLabelText('Area code'), { target: { value: '216' } });
    await tap('Look for a number');
    vi.mocked(fetch).mockImplementationOnce(() =>
      Promise.resolve(json(409, { error: 'PHONE_BILLING_REQUIRED', message: 'Complete trial checkout before claiming a phone number.' })),
    );
    await tap('That works');
    expect(screen.getByRole('alert')).toHaveTextContent('Your trial has to start before I can get you a number.');
    expect(screen.getByText(formatted(FIRST))).toBeInTheDocument();
  });
});
