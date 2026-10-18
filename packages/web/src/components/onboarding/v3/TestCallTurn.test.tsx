/**
 * The test-call turn against the real useApiClient with `fetch` stubbed.
 * `test_call_initiated` keeps the meaning it has in the original test-call step,
 * so the launch funnel stays comparable.
 */
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { expectAllTapTargets, expectTapTarget } from '../../../test-utils/tap-target';
import { json } from './__fixtures__/after';

const analytics = vi.hoisted(() => ({ trackFunnel: vi.fn(), track: vi.fn() }));
vi.mock('../../../lib/analytics', () => analytics);

import { TestCallTurn, type TestCallTurnProps } from './TestCallTurn';
import { TurnFrame } from './TurnFrame';

const NUMBER = '+12165550180';
let goLive: () => Response | Promise<Response>;
let requests: string[];

function stub() {
  requests = [];
  goLive = () => json(200, { voiceAgentLive: true });
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const call = `${init?.method ?? 'GET'} ${String(input)}`;
      requests.push(call);
      if (call === 'POST /api/voice/go-live') return Promise.resolve(goLive());
      throw new Error(`unexpected request ${call}`);
    }),
  );
}

function renderTurn(over: Partial<TestCallTurnProps> = {}) {
  const props: TestCallTurnProps = {
    phoneNumber: NUMBER,
    heard: false,
    tenantId: 'tenant-1',
    userId: 'user-1',
    testLaterError: null,
    onOpened: vi.fn(),
    ...over,
  };
  const view = render(
    <TurnFrame minutesLeft={1} progress={0.9} statusLabel="Almost open">
      <TestCallTurn {...props} />
    </TurnFrame>,
  );
  return { ...view, props };
}

const initiated = () => analytics.trackFunnel.mock.calls.filter(([event]) => event === 'test_call_initiated');

describe('TestCallTurn', () => {
  beforeEach(() => {
    stub();
    analytics.trackFunnel.mockClear();
    analytics.track.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(navigator, 'clipboard');
  });

  describe('waiting for the call', () => {
    it('says "Now you call me." with the scenario to say, the number as a link, and a copy button', () => {
      const { container } = renderTurn();
      expect(screen.getByRole('heading', { level: 1, name: 'Now you call me.' })).toBeInTheDocument();
      // No pack given: the trade-neutral scenario. The per-trade lines are pinned in test-call-scenario.test.ts.
      expect(screen.getByText("Say you've got a problem you'd like looked at. Ask for next Tuesday.")).toBeInTheDocument();
      const link = screen.getByRole('link', { name: '(216) 555-0180' });
      expect(link).toHaveAttribute('href', 'tel:+12165550180');
      expect(screen.getByRole('button', { name: 'Copy number' })).toBeInTheDocument();
      expect(screen.getByRole('status')).toHaveTextContent('Waiting for your call.');
      expectTapTarget(link, 'number link');
      expectAllTapTargets(container, 'test call turn');
      expect(initiated()).toHaveLength(0);
    });

    it('builds the dial link from digits only', () => {
      renderTurn({ phoneNumber: '+1 (216) 555-0180' });
      expect(screen.getByRole('link')).toHaveAttribute('href', 'tel:+12165550180');
    });

    it('records the intent to call when the number is tapped, once for the visit however it is tapped', async () => {
      Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
      renderTurn();
      const link = screen.getByRole('link');
      link.addEventListener('click', (event) => event.preventDefault());
      await userEvent.click(link);
      await userEvent.click(link);
      await userEvent.click(screen.getByRole('button', { name: 'Copy number' }));
      expect(initiated()).toEqual([['test_call_initiated', { tenantId: 'tenant-1', userId: 'user-1' }]]);
    });

    it('records the intent when the number is copied, and copies the number the API reported', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.assign(navigator, { clipboard: { writeText } });
      renderTurn();
      await userEvent.click(screen.getByRole('button', { name: 'Copy number' }));
      expect(writeText).toHaveBeenCalledWith(NUMBER);
      expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();
      expect(initiated()).toHaveLength(1);
    });

    it('still records the intent, and does not say "Copied", when the browser will not copy', async () => {
      Object.assign(navigator, { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } });
      renderTurn();
      await userEvent.click(screen.getByRole('button', { name: 'Copy number' }));
      expect(screen.queryByRole('button', { name: 'Copied' })).not.toBeInTheDocument();
      expect(initiated()).toHaveLength(1);
    });

    it('says so after a minute with no call, and what to do', () => {
      vi.useFakeTimers();
      renderTurn();
      act(() => void vi.advanceTimersByTime(59_999));
      expect(screen.getByRole('status')).toHaveTextContent('Waiting for your call.');
      act(() => void vi.advanceTimersByTime(1));
      expect(screen.getByRole('status')).toHaveTextContent("I haven't heard it yet. Try calling again, or tap I'll test later.");
    });

    it('shows why "I\'ll test later" did not work', () => {
      renderTurn({ testLaterError: "That didn't go through. Try again." });
      expect(screen.getByRole('alert')).toHaveTextContent("That didn't go through. Try again.");
    });

    it('has no number card, and still waits, if the API has not reported a number', () => {
      renderTurn({ phoneNumber: null });
      expect(screen.queryByRole('link')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Copy number' })).not.toBeInTheDocument();
      expect(screen.getByRole('status')).toHaveTextContent('Waiting for your call.');
    });
  });

  describe('once the call was heard', () => {
    it('asks to open for business, and says what happens on the first real call', () => {
      const { container } = renderTurn({ heard: true });
      const heading = screen.getByRole('heading', { level: 1, name: 'I got your call. Ready to open for business?' });
      expect(heading.textContent!.split(/\s+/).length).toBeLessThan(20);
      expect(
        screen.getByText('Every job I book lands for your OK: one tap to confirm, one tap to undo, and you can always hear the call.'),
      ).toBeInTheDocument();
      const open = screen.getByRole('button', { name: "That's right. Open for business." });
      expectTapTarget(open, 'open for business');
      expect(open.className).toMatch(/whitespace-normal/);
      expect(screen.queryByRole('link')).not.toBeInTheDocument();
      expect(screen.queryByText('Waiting for your call.')).not.toBeInTheDocument();
      expectAllTapTargets(container, 'heard');
    });

    it('opens for business through the real go-live route, records it, and tells the shell', async () => {
      const { props } = renderTurn({ heard: true });
      await userEvent.click(screen.getByRole('button', { name: "That's right. Open for business." }));
      await waitFor(() => expect(props.onOpened).toHaveBeenCalledTimes(1));
      expect(requests).toEqual(['POST /api/voice/go-live']);
      expect(analytics.track).toHaveBeenCalledWith('voice_agent_turned_on');
    });

    it('sends one request however many times it is tapped', async () => {
      let finish: (r: Response) => void = () => {};
      goLive = () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        });
      const { props } = renderTurn({ heard: true });
      await userEvent.dblClick(screen.getByRole('button', { name: /Open for business/ }));
      expect(requests).toEqual(['POST /api/voice/go-live']);
      finish(json(200, { voiceAgentLive: true }));
      await waitFor(() => expect(props.onOpened).toHaveBeenCalledTimes(1));
    });

    it('says the trial has to be active when the API answers 402, and stays here', async () => {
      goLive = () => json(402, { error: 'BILLING_REQUIRED', message: 'Active subscription required' });
      const { props } = renderTurn({ heard: true });
      await userEvent.click(screen.getByRole('button', { name: "That's right. Open for business." }));
      expect(await screen.findByRole('alert')).toHaveTextContent("Your trial isn't active yet. Give it a minute, then try again.");
      expect(props.onOpened).not.toHaveBeenCalled();
      expect(analytics.track).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: "That's right. Open for business." })).toBeEnabled();
    });

    it('says it could not open for any other refusal, without the API\'s words', async () => {
      goLive = () => json(500, { error: 'INTERNAL', message: 'pool exhausted' });
      renderTurn({ heard: true });
      await userEvent.click(screen.getByRole('button', { name: "That's right. Open for business." }));
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent("I couldn't open for business just now. Try again.");
      expect(alert.textContent).not.toMatch(/pool/);
    });

    it('says so when the connection drops', async () => {
      goLive = () => Promise.reject(new TypeError('Failed to fetch'));
      const { props } = renderTurn({ heard: true });
      await userEvent.click(screen.getByRole('button', { name: "That's right. Open for business." }));
      expect(await screen.findByRole('alert')).toHaveTextContent("I couldn't reach the server. Check your connection and try again.");
      expect(props.onOpened).not.toHaveBeenCalled();
    });
  });

  it('never says the words Rivet never says', () => {
    const waiting = renderTurn();
    expect(waiting.container.textContent).not.toMatch(/stripe|twilio|\bAI\b|agent|dashboard|verify|provisioning|proposal/i);
    waiting.unmount();
    const heard = renderTurn({ heard: true });
    expect(heard.container.textContent).not.toMatch(/stripe|twilio|\bAI\b|agent|dashboard|verify|provisioning|proposal/i);
  });
});
