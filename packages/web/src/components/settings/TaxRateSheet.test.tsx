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

import { TaxRateSheet } from './TaxRateSheet';

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}): Response {
  const ok = init.ok ?? true;
  return {
    ok,
    status: init.status ?? (ok ? 200 : 500),
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

describe('TaxRateSheet (#1288)', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    toastSuccess.mockReset();
    toastError.mockReset();
  });

  it('hydrates the default rate as a percent', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse({ defaultTaxRateBps: 825 }));
    render(<TaxRateSheet onClose={() => {}} />);
    const input = (await screen.findByLabelText(/Default tax rate/i)) as HTMLInputElement;
    expect(input.value).toBe('8.25');
  });

  it('saves: converts % → integer bps on the wire', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse({ defaultTaxRateBps: 0 }));
    apiFetchMock.mockResolvedValueOnce(jsonResponse({}));
    const onClose = vi.fn();
    render(<TaxRateSheet onClose={onClose} />);
    const input = await screen.findByLabelText(/Default tax rate/i);
    fireEvent.change(input, { target: { value: '8.25' } });
    fireEvent.click(screen.getByRole('button', { name: /Save/i }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(putBody()).toEqual({ defaultTaxRateBps: 825 });
  });

  it('refuses a rate above 100% without calling the API', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse({ defaultTaxRateBps: 0 }));
    render(<TaxRateSheet onClose={() => {}} />);
    const input = await screen.findByLabelText(/Default tax rate/i);
    fireEvent.change(input, { target: { value: '101' } });
    fireEvent.click(screen.getByRole('button', { name: /Save/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/between 0 and 100/i);
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
  });

  it('meets the 44px tap-target contract on the input and buttons', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse({ defaultTaxRateBps: 0 }));
    render(<TaxRateSheet onClose={() => {}} />);
    const input = await screen.findByLabelText(/Default tax rate/i);
    expect(input.className).toContain('min-h-11');
    expect(screen.getByRole('button', { name: /Save/i }).className).toContain('min-h-11');
    expect(screen.getByRole('button', { name: /Cancel/i }).className).toContain('min-h-11');
  });
});
