/**
 * The voice check as the pre-state of the test call: "Getting my voice ready."
 * Real useApiClient, `fetch` stubbed. Both buttons are the original check's own
 * routes (retry and skip).
 */
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OnboardingStep } from '../../../types/onboarding';
import { expectAllTapTargets } from '../../../test-utils/tap-target';
import { json } from './__fixtures__/after';
import { GettingReadyTurn } from './GettingReadyTurn';
import { TurnFrame } from './TurnFrame';

let respond: Record<string, (() => Response | Promise<Response>) | undefined>;
let requests: string[];

function stub() {
  requests = [];
  respond = {
    'POST /api/onboarding/ai-check/retry': () => json(200, { ok: true, enqueued: true }),
    'POST /api/onboarding/ai-check/skip': () => json(200, { ok: true, skipped: true }),
  };
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const call = `${init?.method ?? 'GET'} ${String(input)}`;
      requests.push(call);
      const handler = respond[call];
      if (!handler) throw new Error(`unexpected request ${call}`);
      return Promise.resolve(handler());
    }),
  );
}

const check = (over: Partial<OnboardingStep> = {}): OnboardingStep => ({ id: 'ai_check', status: 'current', ...over });

function renderTurn(step: OnboardingStep | undefined, onChanged = vi.fn()) {
  const view = render(
    <TurnFrame minutesLeft={1} progress={0.9} statusLabel="Almost open">
      <GettingReadyTurn step={step} onChanged={onChanged} />
    </TurnFrame>,
  );
  return { ...view, onChanged };
}

describe('GettingReadyTurn', () => {
  beforeEach(stub);
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  describe('while Rivet is getting its voice ready', () => {
    it.each([
      ['verifying', check({ metadata: { verifying: true } })],
      ['waiting to start', check()],
      ['no status yet', undefined],
    ])('says so (%s), and offers a way out from the start', (_name, step) => {
      const { container } = renderTurn(step);
      expect(screen.getByRole('heading', { level: 1, name: 'Getting my voice ready.' })).toBeInTheDocument();
      expect(screen.getByText('This takes a few seconds.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Skip for now' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
      expectAllTapTargets(container, 'getting my voice ready');
      expect(requests).toEqual([]);
    });

    it('says "Still with you." after four seconds, and offers Try again after twenty', () => {
      vi.useFakeTimers();
      renderTurn(check({ metadata: { verifying: true } }));
      act(() => void vi.advanceTimersByTime(4_000));
      expect(screen.getByText('Still with you.')).toBeInTheDocument();
      act(() => void vi.advanceTimersByTime(16_000));
      expect(screen.getByText('This is taking longer than usual.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Skip for now' })).toBeInTheDocument();
    });

    it('sends the check again from Try again, and checks the status', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const { onChanged } = renderTurn(check());
      act(() => void vi.advanceTimersByTime(20_000));
      await userEvent.setup({ advanceTimers: vi.advanceTimersByTime }).click(screen.getByRole('button', { name: 'Try again' }));
      await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
      expect(requests).toEqual(['POST /api/onboarding/ai-check/retry']);
    });

    it('skips for now with one tap and checks the status', async () => {
      const { onChanged } = renderTurn(check());
      await userEvent.click(screen.getByRole('button', { name: 'Skip for now' }));
      await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
      expect(requests).toEqual(['POST /api/onboarding/ai-check/skip']);
    });
  });

  describe('when the check did not pass', () => {
    it.each([
      ['ai_config_missing', "I'm not ready to answer calls yet, which usually clears up on its own; if it doesn't, contact support."],
      ['ai_verification_failed', "I didn't sound right on my last check. Try again and I'll go over it once more."],
    ])('says what %s means in the owner\'s words, with Try again and Skip for now', (blocker, line) => {
      const { container } = renderTurn(check({ status: 'error', blockers: [blocker], metadata: { error: 'model returned 500: upstream' } }));
      expect(screen.getByRole('heading', { level: 1, name: "I couldn't get my voice ready." })).toBeInTheDocument();
      expect(screen.getByText(line)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Skip for now' })).toBeInTheDocument();
      expect(screen.getByText("Skipping is fine. You can run my check again later in Settings.")).toBeInTheDocument();
      // The raw detail the API keeps for support is never shown.
      expect(document.body.textContent).not.toMatch(/upstream|500|\bAI\b|verify/i);
      expectAllTapTargets(container, 'voice check error');
    });

    it('falls back to a plain line for a blocker it has never heard of', () => {
      renderTurn(check({ status: 'error', blockers: ['something_new'] }));
      expect(screen.getByText("I couldn't get my voice ready. Try again.")).toBeInTheDocument();
    });

    it('retries through the real route and checks the status', async () => {
      const { onChanged } = renderTurn(check({ status: 'error', blockers: ['ai_verification_failed'] }));
      await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
      await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
      expect(requests).toEqual(['POST /api/onboarding/ai-check/retry']);
    });

    it('skips through the real route and checks the status', async () => {
      const { onChanged } = renderTurn(check({ status: 'error', blockers: ['ai_verification_failed'] }));
      await userEvent.click(screen.getByRole('button', { name: 'Skip for now' }));
      await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
      expect(requests).toEqual(['POST /api/onboarding/ai-check/skip']);
    });

    it('keeps the screen and says why when a retry is refused', async () => {
      respond['POST /api/onboarding/ai-check/retry'] = () => json(500, { error: 'AI_CHECK_RETRY_FAILED', message: 'boom' });
      const { onChanged } = renderTurn(check({ status: 'error', blockers: ['ai_verification_failed'] }));
      await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent("That didn't go through. Wait a minute and try again.");
      expect(alert.textContent).not.toMatch(/boom/);
      expect(onChanged).not.toHaveBeenCalled();
      // The owner is not stuck: skipping is still there.
      expect(screen.getByRole('button', { name: 'Skip for now' })).toBeEnabled();
    });

    it('keeps the screen and says why when the connection drops during a skip', async () => {
      respond['POST /api/onboarding/ai-check/skip'] = () => Promise.reject(new TypeError('Failed to fetch'));
      renderTurn(check({ status: 'error', blockers: ['ai_verification_failed'] }));
      await userEvent.click(screen.getByRole('button', { name: 'Skip for now' }));
      expect(await screen.findByRole('alert')).toHaveTextContent("I couldn't reach the server. Check your connection and try again.");
    });

    it('does not send two requests on a double tap', async () => {
      let finish: (r: Response) => void = () => {};
      respond['POST /api/onboarding/ai-check/retry'] = () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        });
      const { onChanged } = renderTurn(check({ status: 'error', blockers: ['ai_verification_failed'] }));
      await userEvent.dblClick(screen.getByRole('button', { name: 'Try again' }));
      expect(requests).toEqual(['POST /api/onboarding/ai-check/retry']);
      finish(json(200, { ok: true }));
      await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    });
  });
});
