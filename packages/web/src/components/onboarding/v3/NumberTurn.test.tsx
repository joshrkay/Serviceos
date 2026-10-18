/** The number turn against the real useApiClient with `fetch` stubbed. */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OnboardingStep } from '../../../types/onboarding';
import { expectAllTapTargets } from '../../../test-utils/tap-target';
import { json } from './__fixtures__/after';
import { NumberTurn } from './NumberTurn';
import { TurnFrame } from './TurnFrame';

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
      expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
      act(() => void vi.advanceTimersByTime(1));
      expect(screen.getByText('This is taking longer than usual.')).toBeInTheDocument();
      screen.getByRole('button', { name: 'Try again' }).click();
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
      ['twilio_provisioning_failed', "I couldn't get you a number this time. Try again and I'll look for another."],
      ['twilio_credentials_missing', "I can't set up phone numbers on your account yet. Please contact support."],
      ['area_code_unavailable', "There were no free numbers in your area code. Try again and I'll look in the next one."],
      ['rate_limited', "I've tried a few times already. Give it a minute, then try again."],
    ])('says what %s means, without the vendor or the mechanism', (blocker, line) => {
      renderTurn(phone({ status: 'error', blockers: [blocker] }));
      expect(screen.getByRole('heading', { level: 1, name: "I couldn't get your number yet." })).toBeInTheDocument();
      expect(screen.getByText(line)).toBeInTheDocument();
      expect(document.body.textContent).not.toMatch(/twilio|provisioning|_/i);
    });

    it('asks the API again with "Try again" and checks the status when it was accepted', async () => {
      const { container, onChanged } = renderTurn(phone({ status: 'error', blockers: ['area_code_unavailable'] }));
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
