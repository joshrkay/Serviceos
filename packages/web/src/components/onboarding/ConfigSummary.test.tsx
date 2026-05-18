/**
 * P4-013 — ConfigSummary error / retry coverage.
 *
 * The remainder of P4-013 (vertical pack activation, terminology persistence,
 * "skip onboarding for returning users") is already satisfied by
 * /api/onboarding/configure + useOnboardingStatus + ProtectedRoute. This
 * suite covers the residual gap that was uncovered during the rescope:
 * the legacy ConfigSummary silently swallowed network errors and advanced
 * to the success screen as if the save succeeded.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const apiFetchMock = vi.fn();
vi.mock('../../utils/api-fetch', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

import { ConfigSummary } from './OnboardingPage';

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}): Response {
  const ok = init.ok ?? true;
  return {
    ok,
    status: init.status ?? (ok ? 200 : 500),
    statusText: ok ? 'OK' : 'Error',
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const answers = {
  name: 'Mike',
  businessName: 'Ortega Services',
  services: ['HVAC', 'Plumbing'],
  teamSize: '2–5 people',
  workerTerm: 'Technicians',
  jobTerm: 'Service calls',
  estimateTerm: 'Estimates',
};

const rules = [
  { id: 'r1', title: 'Reminders', desc: '', icon: 'clock', enabled: true, services: [] as string[] },
  { id: 'r2', title: 'Invoices', desc: '', icon: 'receipt', enabled: false, services: [] as string[] },
];

beforeEach(() => {
  apiFetchMock.mockReset();
});

describe('ConfigSummary — happy path', () => {
  it('POSTs /api/onboarding/configure with the collected answers and calls onConfirm on success', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse({ settings: {}, activatedPacks: ['hvac', 'plumbing'] }));
    const onConfirm = vi.fn();

    render(<ConfigSummary answers={answers} rules={rules} onConfirm={onConfirm} />);
    fireEvent.click(screen.getByText(/Looks good/i));

    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));

    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = apiFetchMock.mock.calls[0];
    expect(url).toBe('/api/onboarding/configure');
    expect((init as RequestInit).method).toBe('POST');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.businessName).toBe('Ortega Services');
    expect(body.services).toEqual(['HVAC', 'Plumbing']);
    expect(body.automationRules).toEqual([
      { id: 'r1', enabled: true },
      { id: 'r2', enabled: false },
    ]);
  });
});

describe('ConfigSummary — error / retry (P4-013 residual gap)', () => {
  it('shows an error alert and does NOT advance when the configure call fails', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse({ error: 'boom' }, { ok: false, status: 500 }));
    const onConfirm = vi.fn();

    render(<ConfigSummary answers={answers} rules={rules} onConfirm={onConfirm} />);
    fireEvent.click(screen.getByText(/Looks good/i));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/couldn't save your setup/i);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByText(/Try again/i)).toBeInTheDocument();
  });

  it('shows the same error when apiFetch throws (network failure)', async () => {
    apiFetchMock.mockRejectedValueOnce(new Error('network down'));
    const onConfirm = vi.fn();

    render(<ConfigSummary answers={answers} rules={rules} onConfirm={onConfirm} />);
    fireEvent.click(screen.getByText(/Looks good/i));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/network down/i);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('retry preserves the collected answers and only advances after a successful save', async () => {
    apiFetchMock
      .mockResolvedValueOnce(jsonResponse({ error: 'boom' }, { ok: false, status: 500 }))
      .mockResolvedValueOnce(jsonResponse({ settings: {}, activatedPacks: ['hvac', 'plumbing'] }));
    const onConfirm = vi.fn();

    render(<ConfigSummary answers={answers} rules={rules} onConfirm={onConfirm} />);
    fireEvent.click(screen.getByText(/Looks good/i));
    await screen.findByRole('alert');
    expect(onConfirm).not.toHaveBeenCalled();

    // Retry — answers + rules are still in the parent scope, so the second
    // POST body should be byte-identical to the first.
    fireEvent.click(screen.getByText(/Try again/i));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));

    expect(apiFetchMock).toHaveBeenCalledTimes(2);
    const first = JSON.parse((apiFetchMock.mock.calls[0][1] as RequestInit).body as string);
    const second = JSON.parse((apiFetchMock.mock.calls[1][1] as RequestInit).body as string);
    expect(second).toEqual(first);
  });
});
