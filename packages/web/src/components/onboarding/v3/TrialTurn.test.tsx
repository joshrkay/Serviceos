/**
 * The trial turn against the real useApiClient with `fetch` stubbed. The plan
 * rows are what GET /billing/plans sends; the failures are the API's own bodies
 * (HERMETIC_*, captured from the running API and asserted again against the
 * real routes in e2e/onboarding-v3-ready-readback.spec.ts).
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { expectAllTapTargets } from '../../../test-utils/tap-target';
import { HERMETIC_CHECKOUT_400, HERMETIC_PLANS_503, PLANS, json } from './__fixtures__/after';
import { TrialTurn } from './TrialTurn';
import { TurnFrame } from './TurnFrame';

interface Sent {
  method: string;
  path: string;
  body?: unknown;
}

let sent: Sent[];
let plansResponses: Array<() => Response | Promise<Response>>;
let checkoutResponse: () => Response | Promise<Response>;

function stub() {
  sent = [];
  plansResponses = [() => json(200, { plans: PLANS })];
  checkoutResponse = () => json(200, { url: 'https://pay.example/session/abc' });
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? 'GET';
      sent.push({ method, path, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
      if (path === '/api/onboarding/billing/plans') {
        const next = plansResponses.length > 1 ? plansResponses.shift()! : plansResponses[0];
        return Promise.resolve(next());
      }
      if (path === '/api/onboarding/billing/checkout-session') return Promise.resolve(checkoutResponse());
      throw new Error(`unexpected request ${method} ${path}`);
    }),
  );
}

const checkouts = () => sent.filter((r) => r.path.endsWith('/checkout-session'));
const planRequests = () => sent.filter((r) => r.path.endsWith('/billing/plans'));

function renderTurn(props: { notice?: string | null; onCheckoutRequested?: (plan: string) => void } = {}) {
  const onCheckoutRequested = props.onCheckoutRequested ?? vi.fn();
  const view = render(
    <TurnFrame minutesLeft={3} progress={0.7} statusLabel="Saved">
      <TrialTurn notice={props.notice ?? null} onCheckoutRequested={onCheckoutRequested} />
    </TurnFrame>,
  );
  return { ...view, onCheckoutRequested };
}

const startButton = () => screen.getByRole('button', { name: /Start my free trial/ });

describe('TrialTurn', () => {
  const realLocation = window.location;

  beforeEach(() => {
    stub();
    // jsdom cannot navigate: stand in for the address bar so the redirect can be read.
    Object.defineProperty(window, 'location', { value: { ...realLocation, href: '' }, writable: true, configurable: true });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    Object.defineProperty(window, 'location', { value: realLocation, writable: true, configurable: true });
  });

  it('opens with Rivet\'s line, what the trial is, and the card footnote, while the plans load', async () => {
    plansResponses = [() => new Promise<Response>(() => {})];
    renderTurn();
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading).toHaveTextContent('Last thing before your number: start your free trial.');
    expect(heading.textContent!.split(/\s+/).length).toBeLessThan(20);
    expect(screen.getByText("It's free for 14 days, and you can cancel any time in Settings.")).toBeInTheDocument();
    expect(screen.getByText(/You'll add a card on a secure page/)).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Getting the plans' })).toBeInTheDocument();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    expect(startButton()).toBeDisabled();
    await waitFor(() => expect(planRequests()).toHaveLength(1));
  });

  it('shows the real plans as rows: name and price from cents, users and minutes, no "most shops" mark', async () => {
    renderTurn();
    const group = await screen.findByRole('radiogroup');
    const rows = within(group).getAllByRole('radio');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveAccessibleName('Starter, $79 a month');
    expect(rows[0]).toHaveAccessibleDescription('Includes 2 users and 20 minutes of answered calls.');
    expect(rows[1]).toHaveAccessibleName('Growth, $199 a month');
    expect(rows[1]).toHaveAccessibleDescription('Includes 5 users and 60 minutes of answered calls.');
    expect(screen.queryByText('Most shops like yours')).not.toBeInTheDocument();
    for (const row of rows) expect(row).toHaveAttribute('aria-checked', 'false');
    // Choosing a plan is the owner's: nothing is picked for them.
    expect(startButton()).toBeDisabled();
  });

  it('enables the button once a plan is picked', async () => {
    renderTurn();
    await userEvent.click(await screen.findByRole('radio', { name: /Growth/ }));
    expect(screen.getByRole('radio', { name: /Growth/ })).toHaveAttribute('aria-checked', 'true');
    expect(startButton()).toBeEnabled();
  });

  it('picks the only plan for the owner when there is just one', async () => {
    plansResponses = [() => json(200, { plans: [PLANS[1]] })];
    renderTurn();
    expect(await screen.findByRole('radio', { name: /Growth/ })).toHaveAttribute('aria-checked', 'true');
    expect(startButton()).toBeEnabled();
  });

  it('requests the checkout for the picked plan, tells the shell once, and follows the returned page', async () => {
    const { onCheckoutRequested } = renderTurn();
    await userEvent.click(await screen.findByRole('radio', { name: /Growth/ }));
    await userEvent.click(startButton());

    await waitFor(() => expect(window.location.href).toBe('https://pay.example/session/abc'));
    expect(checkouts()).toEqual([{ method: 'POST', path: '/api/onboarding/billing/checkout-session', body: { planId: 'growth' } }]);
    expect(onCheckoutRequested).toHaveBeenCalledTimes(1);
    expect(onCheckoutRequested).toHaveBeenCalledWith('growth');
  });

  it('holds the plans and the button while the checkout is being requested, so a second tap cannot start a second one', async () => {
    let finish: (r: Response) => void = () => {};
    checkoutResponse = () => new Promise<Response>((resolve) => {
        finish = resolve;
      });
    renderTurn();
    await userEvent.click(await screen.findByRole('radio', { name: /Starter/ }));
    await userEvent.dblClick(startButton());

    await waitFor(() => expect(startButton()).toBeDisabled());
    for (const row of screen.getAllByRole('radio')) expect(row).toBeDisabled();
    expect(checkouts()).toHaveLength(1);
    finish(json(200, { url: 'https://pay.example/s' }));
    await waitFor(() => expect(window.location.href).toBe('https://pay.example/s'));
    await waitFor(() => expect(startButton()).toBeEnabled());
  });

  describe('when the checkout fails', () => {
    async function startWith(response: () => Response | Promise<Response>) {
      checkoutResponse = response;
      const view = renderTurn();
      await userEvent.click(await screen.findByRole('radio', { name: /Starter/ }));
      await userEvent.click(startButton());
      return view;
    }

    it('turns the API\'s own 400 (a plan price that is not set) into words for an owner, on this screen, with the plan still picked', async () => {
      await startWith(() => json(400, HERMETIC_CHECKOUT_400));
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent("I couldn't start your trial. Wait a minute and try again, or contact support.");
      expect(alert.textContent).not.toMatch(/STRIPE|configured|not set|starter"/);
      expect(screen.getByRole('radio', { name: /Starter/ })).toHaveAttribute('aria-checked', 'true');
      expect(startButton()).toBeEnabled();
      expect(window.location.href).toBe('');
    });

    it('keeps a plain message from the API as it is', async () => {
      await startWith(() => json(400, { error: 'VALIDATION_ERROR', message: 'A checkout was just started. Complete it or wait a moment before trying again.' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('A checkout was just started. Complete it or wait a moment before trying again.');
    });

    it('says billing is not available on a 503', async () => {
      await startWith(() => json(503, { error: 'BILLING_NOT_CONFIGURED', message: 'Subscription billing is not configured' }));
      expect(await screen.findByRole('alert')).toHaveTextContent("I can't start trials right now. Try again in a minute, or contact support.");
    });

    it('says to wait a minute on any other server error', async () => {
      await startWith(() => json(502, { error: 'BAD_GATEWAY', message: 'upstream timeout' }));
      expect(await screen.findByRole('alert')).toHaveTextContent("I can't start the checkout right now. Wait a minute and try again.");
    });

    it('says only the owner can start it to a teammate', async () => {
      await startWith(() => json(403, { error: 'FORBIDDEN', message: 'Forbidden' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('Only the owner can start the trial.');
    });

    it('says so when the connection drops', async () => {
      await startWith(() => Promise.reject(new TypeError('Failed to fetch')));
      expect(await screen.findByRole('alert')).toHaveTextContent("I couldn't reach the checkout. Check your connection and try again.");
    });

    it('says so when the API sends no page to go to', async () => {
      await startWith(() => json(200, {}));
      expect(await screen.findByRole('alert')).toHaveTextContent("I couldn't open the checkout page. Try again, or contact support.");
    });

    it('lets the owner try again, and clears the line once they do', async () => {
      await startWith(() => json(502, { message: 'upstream timeout' }));
      await screen.findByRole('alert');
      checkoutResponse = () => json(200, { url: 'https://pay.example/second' });
      await userEvent.click(startButton());
      await waitFor(() => expect(window.location.href).toBe('https://pay.example/second'));
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(checkouts()).toHaveLength(2);
    });
  });

  describe('when the plans cannot be shown', () => {
    it('says so in the owner\'s words for the API\'s own 503, with no plan rows and no Start button, and a way to try again', async () => {
      plansResponses = [() => json(503, HERMETIC_PLANS_503)];
      const { container } = renderTurn();
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent("I can't show the plans right now. Try again in a minute, or contact support.");
      expect(alert.textContent).not.toMatch(/configured/i);
      expect(screen.queryByRole('radio')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Start my free trial/ })).not.toBeInTheDocument();
      expectAllTapTargets(container, 'trial turn with the plans unavailable');
    });

    it('asks the API again on "Try again" and shows the plans when they have come back', async () => {
      plansResponses = [() => json(503, HERMETIC_PLANS_503), () => json(200, { plans: PLANS })];
      renderTurn();
      await screen.findByRole('alert');
      await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
      expect(await screen.findAllByRole('radio')).toHaveLength(2);
      expect(planRequests()).toHaveLength(2);
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(startButton()).toBeDisabled();
    });

    it('treats an empty list like an outage, never a screen with nothing to pick', async () => {
      plansResponses = [() => json(200, { plans: [] })];
      renderTurn();
      expect(await screen.findByRole('alert')).toHaveTextContent("I can't show the plans right now.");
      expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
    });

    it('says so when the connection drops', async () => {
      plansResponses = [() => Promise.reject(new TypeError('Failed to fetch'))];
      renderTurn();
      expect(await screen.findByRole('alert')).toHaveTextContent("I couldn't reach the checkout. Check your connection and try again.");
    });
  });

  it('shows the one-line notice from the payment page, and drops it when the owner starts again', async () => {
    renderTurn({ notice: "No problem. Your trial hasn't started. Start it whenever you're ready." });
    expect(await screen.findByRole('status')).toHaveTextContent("No problem. Your trial hasn't started. Start it whenever you're ready.");
    await userEvent.click(await screen.findByRole('radio', { name: /Starter/ }));
    await userEvent.click(startButton());
    await waitFor(() => expect(window.location.href).not.toBe(''));
    expect(screen.queryByText(/No problem/)).not.toBeInTheDocument();
  });

  it('never says the words Rivet never says, on any state of the turn', async () => {
    const forbidden = /stripe|twilio|\bAI\b|agent|dashboard|verify|provisioning|proposal/i;
    const view = renderTurn();
    await screen.findByRole('radiogroup');
    expect(view.container.textContent).not.toMatch(forbidden);
  });
});
