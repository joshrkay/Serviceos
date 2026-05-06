import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const apiFetchMock = vi.fn();
vi.mock('../../utils/api-fetch', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    success: (msg: string) => toastSuccess(msg),
    error: (msg: string) => toastError(msg),
  },
}));

import { DepositRulesSheet } from './DepositRulesSheet';

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

describe('DepositRulesSheet — Tier 4 stub closure (PR 1: data plane only)', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    toastSuccess.mockReset();
    toastError.mockReset();
  });

  it('hydrates with "No deposit" when no settings exist yet', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse({}));
    render(<DepositRulesSheet onClose={() => {}} />);
    await waitFor(() => {
      const noDepositRadio = screen.getByLabelText(/No deposit/i) as HTMLInputElement;
      expect(noDepositRadio.checked).toBe(true);
    });
    // Conditional fields are hidden when strategy === 'none'.
    expect(screen.queryByLabelText(/^Percentage$/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^Deposit amount$/i)).not.toBeInTheDocument();
  });

  it('hydrates a percentage rule from existing settings', async () => {
    apiFetchMock.mockResolvedValueOnce(
      jsonResponse({
        depositStrategy: 'percentage',
        depositPercentageBps: 2500, // 25%
        depositRequiredAboveCents: 50000, // $500.00 threshold
      }),
    );
    render(<DepositRulesSheet onClose={() => {}} />);
    const pctRadio = (await screen.findByLabelText(/Percentage of total/i)) as HTMLInputElement;
    expect(pctRadio.checked).toBe(true);
    const pctInput = screen.getByLabelText(/^Percentage$/i) as HTMLInputElement;
    expect(pctInput.value).toBe('25');
    const thresholdInput = screen.getByLabelText(/Only require above/i) as HTMLInputElement;
    expect(thresholdInput.value).toBe('500.00');
  });

  it('hydrates a fixed rule from existing settings', async () => {
    apiFetchMock.mockResolvedValueOnce(
      jsonResponse({
        depositStrategy: 'fixed',
        depositFixedCents: 25000, // $250
      }),
    );
    render(<DepositRulesSheet onClose={() => {}} />);
    const fixedRadio = (await screen.findByLabelText(/Fixed amount/i)) as HTMLInputElement;
    expect(fixedRadio.checked).toBe(true);
    const fixedInput = screen.getByLabelText(/^Deposit amount$/i) as HTMLInputElement;
    expect(fixedInput.value).toBe('250.00');
  });

  it('saves a percentage rule and converts UI percent → bps', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse({}));
    apiFetchMock.mockResolvedValueOnce(jsonResponse({}));
    const onClose = vi.fn();
    render(<DepositRulesSheet onClose={onClose} />);

    fireEvent.click(await screen.findByLabelText(/Percentage of total/i));
    const pctInput = screen.getByLabelText(/^Percentage$/i) as HTMLInputElement;
    fireEvent.change(pctInput, { target: { value: '25' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const putCall = apiFetchMock.mock.calls.find(
      (c) => c[1] && (c[1] as RequestInit).method === 'PUT',
    );
    const body = JSON.parse((putCall![1] as RequestInit).body as string);
    expect(body.depositStrategy).toBe('percentage');
    expect(body.depositPercentageBps).toBe(2500);
    expect(body.depositFixedCents).toBeNull();
    expect(toastSuccess).toHaveBeenCalledWith('Deposit rules saved');
  });

  it('saves a fixed rule and converts dollars → cents', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse({}));
    apiFetchMock.mockResolvedValueOnce(jsonResponse({}));
    const onClose = vi.fn();
    render(<DepositRulesSheet onClose={onClose} />);

    fireEvent.click(await screen.findByLabelText(/Fixed amount/i));
    const fixedInput = screen.getByLabelText(/^Deposit amount$/i) as HTMLInputElement;
    fireEvent.change(fixedInput, { target: { value: '500' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const putCall = apiFetchMock.mock.calls.find(
      (c) => c[1] && (c[1] as RequestInit).method === 'PUT',
    );
    const body = JSON.parse((putCall![1] as RequestInit).body as string);
    expect(body.depositStrategy).toBe('fixed');
    expect(body.depositFixedCents).toBe(50000);
    expect(body.depositPercentageBps).toBeNull();
  });

  it('rejects percentage > 100 inline', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse({}));
    render(<DepositRulesSheet onClose={() => {}} />);

    fireEvent.click(await screen.findByLabelText(/Percentage of total/i));
    const pctInput = screen.getByLabelText(/^Percentage$/i) as HTMLInputElement;
    fireEvent.change(pctInput, { target: { value: '150' } });
    fireEvent.click(screen.getByText('Save'));

    await screen.findByText(/between 0 and 100/i);
    // No PUT was attempted.
    const putCalls = apiFetchMock.mock.calls.filter(
      (c) => c[1] && (c[1] as RequestInit).method === 'PUT',
    );
    expect(putCalls).toHaveLength(0);
  });

  it('rejects fixed strategy when amount is empty', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse({}));
    render(<DepositRulesSheet onClose={() => {}} />);

    fireEvent.click(await screen.findByLabelText(/Fixed amount/i));
    fireEvent.click(screen.getByText('Save'));

    await screen.findByText(/Fixed deposit amount is required/i);
  });

  it('clears all amount fields when strategy switches to "No deposit"', async () => {
    apiFetchMock.mockResolvedValueOnce(
      jsonResponse({
        depositStrategy: 'percentage',
        depositPercentageBps: 2500,
      }),
    );
    apiFetchMock.mockResolvedValueOnce(jsonResponse({}));
    const onClose = vi.fn();
    render(<DepositRulesSheet onClose={onClose} />);

    // Hydrated to percentage; switch to no deposit.
    await screen.findByLabelText(/Percentage of total/i);
    fireEvent.click(screen.getByLabelText(/No deposit/i));
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const putCall = apiFetchMock.mock.calls.find(
      (c) => c[1] && (c[1] as RequestInit).method === 'PUT',
    );
    const body = JSON.parse((putCall![1] as RequestInit).body as string);
    expect(body.depositStrategy).toBeNull();
    expect(body.depositPercentageBps).toBeNull();
    expect(body.depositFixedCents).toBeNull();
  });

  it('parses optional threshold as cents and includes it in the payload', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse({}));
    apiFetchMock.mockResolvedValueOnce(jsonResponse({}));
    render(<DepositRulesSheet onClose={() => {}} />);

    fireEvent.click(await screen.findByLabelText(/Percentage of total/i));
    fireEvent.change(screen.getByLabelText(/^Percentage$/i), { target: { value: '20' } });
    fireEvent.change(screen.getByLabelText(/Only require above/i), {
      target: { value: '1000' },
    });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => {
      const putCall = apiFetchMock.mock.calls.find(
        (c) => c[1] && (c[1] as RequestInit).method === 'PUT',
      );
      const body = JSON.parse((putCall![1] as RequestInit).body as string);
      expect(body.depositRequiredAboveCents).toBe(100000);
    });
  });

  it('hydrates depositTimingPolicy from existing settings and persists the chosen value', async () => {
    apiFetchMock.mockResolvedValueOnce(
      jsonResponse({
        depositStrategy: 'percentage',
        depositPercentageBps: 2500,
        depositTimingPolicy: 'before_approval',
      }),
    );
    apiFetchMock.mockResolvedValueOnce(jsonResponse({}));
    const onClose = vi.fn();
    render(<DepositRulesSheet onClose={onClose} />);

    const beforeRadio = (await screen.findByLabelText(
      /Before the customer can approve/i,
    )) as HTMLInputElement;
    expect(beforeRadio.checked).toBe(true);

    // Switch to after_approval and save.
    fireEvent.click(screen.getByLabelText(/After the customer approves/i));
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const putCall = apiFetchMock.mock.calls.find(
      (c) => c[1] && (c[1] as RequestInit).method === 'PUT',
    );
    const body = JSON.parse((putCall![1] as RequestInit).body as string);
    expect(body.depositTimingPolicy).toBe('after_approval');
  });

  it('hides the timing-policy fieldset when strategy is "No deposit"', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse({}));
    render(<DepositRulesSheet onClose={() => {}} />);
    await waitFor(() => {
      expect(
        (screen.getByLabelText(/No deposit/i) as HTMLInputElement).checked,
      ).toBe(true);
    });
    expect(screen.queryByLabelText(/After the customer approves/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Before the customer can approve/i)).not.toBeInTheDocument();
  });

  it('surfaces server errors via toast and inline message', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse({}));
    apiFetchMock.mockResolvedValueOnce(
      jsonResponse({ message: 'Validation failed' }, { ok: false, status: 400 }),
    );
    const onClose = vi.fn();
    render(<DepositRulesSheet onClose={onClose} />);

    fireEvent.click(await screen.findByLabelText(/Fixed amount/i));
    fireEvent.change(screen.getByLabelText(/^Deposit amount$/i), { target: { value: '500' } });
    fireEvent.click(screen.getByText('Save'));

    await screen.findByText(/Validation failed/);
    expect(toastError).toHaveBeenCalledWith('Validation failed');
    expect(onClose).not.toHaveBeenCalled();
  });
});
