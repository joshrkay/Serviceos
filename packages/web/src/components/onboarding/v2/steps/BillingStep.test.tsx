import { render, fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const apiFetchMock = vi.fn();
vi.mock('../../../../lib/apiClient', () => ({ useApiClient: () => apiFetchMock }));

import { BillingStep } from './BillingStep';

const PLANS = [
  { id: 'basic', name: 'Basic', amountCents: 5_000, currency: 'usd', interval: 'month' },
  { id: 'enterprise', name: 'Enterprise', amountCents: 15_000, currency: 'usd', interval: 'month' },
];

function mockPlansOk() {
  apiFetchMock.mockImplementation(async (path: string) => {
    if (path === '/api/onboarding/billing/plans') {
      return { ok: true, json: async () => ({ plans: PLANS }) };
    }
    return { ok: true, json: async () => ({}) };
  });
}

describe('BillingStep — explicit plan selection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders both plans as an accessible radiogroup with nothing selected by default', async () => {
    mockPlansOk();
    render(<BillingStep />);

    const group = await screen.findByRole('radiogroup', { name: /choose a billing plan/i });
    const options = screen.getAllByRole('radio');
    expect(options).toHaveLength(2);
    for (const opt of options) {
      expect(opt).not.toBeChecked();
    }
    expect(group).toBeInTheDocument();
  });

  it('renders real radio inputs with accessible labels meeting the 44px tap target', async () => {
    mockPlansOk();
    render(<BillingStep />);

    const group = await screen.findByRole('radiogroup');
    const options = screen.getAllByRole('radio');
    for (const opt of options) {
      expect(opt.tagName).toBe('INPUT');
      expect((opt as HTMLInputElement).type).toBe('radio');
    }
    // Each option's label wrapper carries the min tap-target class.
    const labels = group.querySelectorAll('label');
    expect(labels).toHaveLength(2);
    for (const label of labels) {
      expect(label.className).toMatch(/\bmin-h-11\b/);
    }
  });

  it('supports arrow-key navigation between plan options', async () => {
    mockPlansOk();
    render(<BillingStep />);
    await screen.findByRole('radiogroup');

    const basic = screen.getByRole('radio', { name: /basic/i });
    const enterprise = screen.getByRole('radio', { name: /enterprise/i });

    basic.focus();
    fireEvent.keyDown(basic, { key: 'ArrowDown' });
    expect(enterprise).toBeChecked();
    expect(basic).not.toBeChecked();

    fireEvent.keyDown(enterprise, { key: 'ArrowUp' });
    expect(basic).toBeChecked();
    expect(enterprise).not.toBeChecked();

    fireEvent.keyDown(basic, { key: 'ArrowRight' });
    expect(enterprise).toBeChecked();

    fireEvent.keyDown(enterprise, { key: 'ArrowLeft' });
    expect(basic).toBeChecked();
  });

  it('disables the continue button until a plan is selected', async () => {
    mockPlansOk();
    render(<BillingStep />);

    await screen.findByRole('radiogroup');
    const continueBtn = screen.getByRole('button', { name: /start 14-day free trial/i });
    expect(continueBtn).toBeDisabled();

    fireEvent.click(screen.getByRole('radio', { name: /basic/i }));
    expect(continueBtn).not.toBeDisabled();
  });

  it('submits the selected planId and redirects to the returned Stripe url', async () => {
    mockPlansOk();
    const originalLocation = window.location;
    // jsdom throws on direct assignment to window.location.href; stub it out.
    Object.defineProperty(window, 'location', {
      value: { ...originalLocation, href: '' },
      writable: true,
    });

    render(<BillingStep />);
    await screen.findByRole('radiogroup');
    fireEvent.click(screen.getByRole('radio', { name: /enterprise/i }));

    apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/onboarding/billing/checkout-session') {
        expect(JSON.parse(init!.body as string)).toEqual({ planId: 'enterprise' });
        return { ok: true, json: async () => ({ url: 'https://checkout.stripe.com/pay/x' }) };
      }
      return { ok: true, json: async () => ({ plans: PLANS }) };
    });

    fireEvent.click(screen.getByRole('button', { name: /start 14-day free trial/i }));

    await waitFor(() => expect(window.location.href).toBe('https://checkout.stripe.com/pay/x'));
    Object.defineProperty(window, 'location', { value: originalLocation, writable: true });
  });

  it('disables plan selection while checkout is pending', async () => {
    mockPlansOk();
    render(<BillingStep />);
    await screen.findByRole('radiogroup');
    fireEvent.click(screen.getByRole('radio', { name: /basic/i }));

    let resolveCheckout: (value: unknown) => void = () => {};
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/onboarding/billing/checkout-session') {
        return new Promise((resolve) => {
          resolveCheckout = resolve;
        });
      }
      return { ok: true, json: async () => ({ plans: PLANS }) };
    });

    fireEvent.click(screen.getByRole('button', { name: /start 14-day free trial/i }));

    await waitFor(() => {
      for (const radio of screen.getAllByRole('radio')) {
        expect(radio).toBeDisabled();
      }
    });

    resolveCheckout({ ok: false, status: 500, json: async () => ({}) });
    await screen.findByRole('alert');
  });

  it('surfaces the backend-supplied safe message on a 503 (billing not configured)', async () => {
    apiFetchMock.mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ message: 'Subscription billing is not configured' }),
    });
    render(<BillingStep />);

    expect(await screen.findByRole('alert')).toHaveTextContent(/subscription billing is not configured/i);
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
  });

  it('falls back to a generic message on a 503 with no backend message supplied', async () => {
    apiFetchMock.mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({}),
    });
    render(<BillingStep />);

    expect(await screen.findByRole('alert')).toHaveTextContent(/billing is not configured/i);
  });

  it('shows a neutral "checkout unavailable" message on a generic 5xx, not a Stripe-outage claim', async () => {
    apiFetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => ({ message: 'upstream timeout' }),
    });
    render(<BillingStep />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/checkout is temporarily unavailable/i);
    expect(alert).not.toHaveTextContent(/stripe/i);
  });
});
