/**
 * #1143 (row 8.10) — the owner's Settings control for the tenant late-fee
 * policy, backed by GET/PUT /api/settings/dunning. Before this there was no
 * web (or any other) surface that wrote a dunning config, so the overdue sweep
 * never proposed a late fee for any tenant.
 */
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

import { DunningLateFeeSheet } from './DunningLateFeeSheet';

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

const DEFAULT_POLICY = {
  configured: false,
  enabled: true,
  reminderSteps: [{ offsetDays: 3, channel: 'sms' }],
  lateFeeType: 'none',
  lateFeeValueCents: 0,
  lateFeeGraceDays: 0,
  lateFeeMaxCents: null,
};

function putBody(): Record<string, unknown> {
  const putCall = apiFetchMock.mock.calls.find((c) => c[1] && (c[1] as RequestInit).method === 'PUT');
  expect(putCall, 'a PUT was sent').toBeTruthy();
  expect(putCall![0]).toBe('/api/settings/dunning');
  return JSON.parse((putCall![1] as RequestInit).body as string);
}

describe('DunningLateFeeSheet', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    toastSuccess.mockReset();
    toastError.mockReset();
  });

  it('loads from GET /api/settings/dunning and shows "No late fee" for the default policy', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(DEFAULT_POLICY));
    render(<DunningLateFeeSheet onClose={() => {}} />);
    const none = (await screen.findByLabelText(/No late fee/i)) as HTMLInputElement;
    await waitFor(() => expect(none.checked).toBe(true));
    expect(apiFetchMock.mock.calls[0][0]).toBe('/api/settings/dunning');
    // Amount / grace / cap only show for a charging policy.
    expect(screen.queryByLabelText(/^Fee amount$/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Grace period/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Maximum fee/i)).not.toBeInTheDocument();
  });

  it('hydrates a capped flat policy in dollars and days', async () => {
    apiFetchMock.mockResolvedValueOnce(
      jsonResponse({
        ...DEFAULT_POLICY,
        configured: true,
        lateFeeType: 'flat',
        lateFeeValueCents: 5000,
        lateFeeGraceDays: 5,
        lateFeeMaxCents: 2000,
      }),
    );
    render(<DunningLateFeeSheet onClose={() => {}} />);
    const flat = (await screen.findByLabelText(/Flat fee/i)) as HTMLInputElement;
    await waitFor(() => expect(flat.checked).toBe(true));
    expect((screen.getByLabelText(/^Fee amount$/i) as HTMLInputElement).value).toBe('50.00');
    expect((screen.getByLabelText(/Grace period/i) as HTMLInputElement).value).toBe('5');
    expect((screen.getByLabelText(/Maximum fee/i) as HTMLInputElement).value).toBe('20.00');
  });

  it('hydrates a percent policy from basis points', async () => {
    apiFetchMock.mockResolvedValueOnce(
      jsonResponse({ ...DEFAULT_POLICY, configured: true, lateFeeType: 'percent', lateFeeValueCents: 150 }),
    );
    render(<DunningLateFeeSheet onClose={() => {}} />);
    const pct = (await screen.findByLabelText(/Percentage of balance/i)) as HTMLInputElement;
    await waitFor(() => expect(pct.checked).toBe(true));
    expect((screen.getByLabelText(/^Percentage$/i) as HTMLInputElement).value).toBe('1.5');
    expect((screen.getByLabelText(/Maximum fee/i) as HTMLInputElement).value).toBe('');
  });

  it('saves a capped flat fee as integer cents', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(DEFAULT_POLICY));
    apiFetchMock.mockResolvedValueOnce(jsonResponse({}));
    const onClose = vi.fn();
    render(<DunningLateFeeSheet onClose={onClose} />);

    fireEvent.click(await screen.findByLabelText(/Flat fee/i));
    fireEvent.change(screen.getByLabelText(/^Fee amount$/i), { target: { value: '50' } });
    fireEvent.change(screen.getByLabelText(/Grace period/i), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText(/Maximum fee/i), { target: { value: '20' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(putBody()).toEqual({
      lateFeeType: 'flat',
      lateFeeValueCents: 5000,
      lateFeeGraceDays: 5,
      lateFeeMaxCents: 2000,
    });
    expect(toastSuccess).toHaveBeenCalledWith('Late fee policy saved');
  });

  it('saves an uncapped percent fee as basis points with a null cap', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(DEFAULT_POLICY));
    apiFetchMock.mockResolvedValueOnce(jsonResponse({}));
    const onClose = vi.fn();
    render(<DunningLateFeeSheet onClose={onClose} />);

    fireEvent.click(await screen.findByLabelText(/Percentage of balance/i));
    fireEvent.change(screen.getByLabelText(/^Percentage$/i), { target: { value: '1.5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(putBody()).toEqual({
      lateFeeType: 'percent',
      lateFeeValueCents: 150,
      lateFeeGraceDays: 0,
      lateFeeMaxCents: null,
    });
  });

  it('turning the fee off sends only the type', async () => {
    apiFetchMock.mockResolvedValueOnce(
      jsonResponse({ ...DEFAULT_POLICY, configured: true, lateFeeType: 'flat', lateFeeValueCents: 5000 }),
    );
    apiFetchMock.mockResolvedValueOnce(jsonResponse({}));
    const onClose = vi.fn();
    render(<DunningLateFeeSheet onClose={onClose} />);

    fireEvent.click(await screen.findByLabelText(/No late fee/i));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(putBody()).toEqual({ lateFeeType: 'none' });
  });

  it.each([
    ['a flat fee with no amount', 'Flat fee', null, /Fee amount must be greater than \$0/i],
    ['a percentage above 100', 'Percentage of balance', '101', /Percentage must be greater than 0 and at most 100/i],
  ])('blocks %s without calling the API', async (_label, option, value, message) => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(DEFAULT_POLICY));
    const onClose = vi.fn();
    render(<DunningLateFeeSheet onClose={onClose} />);

    fireEvent.click(await screen.findByLabelText(new RegExp(option, 'i')));
    if (value !== null) {
      fireEvent.change(screen.getByLabelText(/^Percentage$/i), { target: { value } });
    }
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(apiFetchMock.mock.calls.some((c) => c[1] && (c[1] as RequestInit).method === 'PUT')).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("surfaces the server's validation message and stays open", async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(DEFAULT_POLICY));
    apiFetchMock.mockResolvedValueOnce(
      jsonResponse({ error: 'VALIDATION_ERROR', message: 'lateFeeValueCents must be a positive integer' }, { ok: false, status: 400 }),
    );
    const onClose = vi.fn();
    render(<DunningLateFeeSheet onClose={onClose} />);

    fireEvent.click(await screen.findByLabelText(/Flat fee/i));
    fireEvent.change(screen.getByLabelText(/^Fee amount$/i), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('lateFeeValueCents must be a positive integer');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('keeps Save and Cancel at the 44px tap-target floor', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(DEFAULT_POLICY));
    render(<DunningLateFeeSheet onClose={() => {}} />);
    await screen.findByLabelText(/No late fee/i);
    expect(screen.getByRole('button', { name: 'Save' }).className).toContain('min-h-11');
    expect(screen.getByRole('button', { name: 'Cancel' }).className).toContain('min-h-11');
  });
});
