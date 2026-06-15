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

import { DiscountPolicySheet } from './DiscountPolicySheet';

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

function putBody(): Record<string, unknown> {
  const putCall = apiFetchMock.mock.calls.find(
    (c) => c[1] && (c[1] as RequestInit).method === 'PUT',
  );
  return JSON.parse((putCall![1] as RequestInit).body as string);
}

describe('DiscountPolicySheet (P2-036 V2)', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    toastSuccess.mockReset();
    toastError.mockReset();
  });

  it('hydrates max %, floor $, and the catalog toggle from existing settings', async () => {
    apiFetchMock.mockResolvedValueOnce(
      jsonResponse({ discountMaxBps: 1000, discountFloorCents: 15000, discountNeverBelowCatalog: true }),
    );
    render(<DiscountPolicySheet onClose={() => {}} />);
    const maxInput = (await screen.findByLabelText(/Maximum discount/i)) as HTMLInputElement;
    expect(maxInput.value).toBe('10'); // 1000 bps → 10%
    expect((screen.getByLabelText(/Never sell below/i) as HTMLInputElement).value).toBe('150.00');
    expect(
      (screen.getByLabelText(/Never below the catalog price/i) as HTMLInputElement).checked,
    ).toBe(true);
  });

  it('saves: converts % → bps and $ → cents', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse({}));
    apiFetchMock.mockResolvedValueOnce(jsonResponse({}));
    const onClose = vi.fn();
    render(<DiscountPolicySheet onClose={onClose} />);

    fireEvent.change(await screen.findByLabelText(/Maximum discount/i), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText(/Never sell below/i), { target: { value: '150' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const body = putBody();
    expect(body.discountMaxBps).toBe(1000);
    expect(body.discountFloorCents).toBe(15000);
    expect(body.discountNeverBelowCatalog).toBe(true);
    expect(toastSuccess).toHaveBeenCalledWith('Discount policy saved');
  });

  it('fail-closed: an empty maximum saves 0 bps (blocks all discounts)', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse({}));
    apiFetchMock.mockResolvedValueOnce(jsonResponse({}));
    render(<DiscountPolicySheet onClose={() => {}} />);

    await screen.findByLabelText(/Maximum discount/i); // empty by default
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => {
      const body = putBody();
      expect(body.discountMaxBps).toBe(0);
      expect(body.discountFloorCents).toBeNull();
    });
  });

  it('rejects a maximum above 100 inline (no PUT)', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse({}));
    render(<DiscountPolicySheet onClose={() => {}} />);

    fireEvent.change(await screen.findByLabelText(/Maximum discount/i), { target: { value: '150' } });
    fireEvent.click(screen.getByText('Save'));

    await screen.findByText(/between 0 and 100/i);
    const putCalls = apiFetchMock.mock.calls.filter(
      (c) => c[1] && (c[1] as RequestInit).method === 'PUT',
    );
    expect(putCalls).toHaveLength(0);
  });

  it('surfaces a server error via toast + inline message', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse({}));
    apiFetchMock.mockResolvedValueOnce(
      jsonResponse({ message: 'Validation failed' }, { ok: false, status: 400 }),
    );
    const onClose = vi.fn();
    render(<DiscountPolicySheet onClose={onClose} />);

    fireEvent.change(await screen.findByLabelText(/Maximum discount/i), { target: { value: '10' } });
    fireEvent.click(screen.getByText('Save'));

    await screen.findByText(/Validation failed/);
    expect(toastError).toHaveBeenCalledWith('Validation failed');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('uses ≥44px tap targets on the action buttons (min-h-11)', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse({}));
    render(<DiscountPolicySheet onClose={() => {}} />);
    await screen.findByLabelText(/Maximum discount/i);
    expect(screen.getByText('Save').className).toMatch(/min-h-11/);
    expect(screen.getByText('Cancel').className).toMatch(/min-h-11/);
  });
});
