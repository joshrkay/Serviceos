/**
 * #1402 §13 — default payment terms (defaultPaymentTermDays) settings sheet.
 * Seam: the rendered sheet, API mocked at apiFetch.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const apiFetchMock = vi.fn();
vi.mock('../../utils/api-fetch', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { PaymentTermsSheet } from './PaymentTermsSheet';

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}): Response {
  const ok = init.ok ?? true;
  return {
    ok,
    status: init.status ?? (ok ? 200 : 500),
    json: async () => body,
  } as unknown as Response;
}

function putBodies(): unknown[] {
  return apiFetchMock.mock.calls
    .filter((c) => (c[1] as RequestInit | undefined)?.method === 'PUT')
    .map((c) => JSON.parse((c[1] as RequestInit).body as string));
}

describe('PaymentTermsSheet (#1402 §13)', () => {
  beforeEach(() => apiFetchMock.mockReset());

  it('shows the stored terms and saves new ones as whole days', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse({ defaultPaymentTermDays: 30 }));
    apiFetchMock.mockResolvedValueOnce(jsonResponse({ defaultPaymentTermDays: 15 }));
    const onClose = vi.fn();
    render(<PaymentTermsSheet onClose={onClose} />);

    const input = (await screen.findByLabelText(/Payment due within/i)) as HTMLInputElement;
    expect(input.value).toBe('30');
    fireEvent.change(input, { target: { value: '15' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(putBodies()).toEqual([{ defaultPaymentTermDays: 15 }]);
  });

  it.each([
    ['366', 'more than a year'],
    ['-1', 'negative'],
    ['7.5', 'fractional'],
    ['', 'blank'],
  ])('refuses %s (%s) with a message and never calls the API', async (value) => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse({ defaultPaymentTermDays: 30 }));
    render(<PaymentTermsSheet onClose={() => {}} />);
    const input = await screen.findByLabelText(/Payment due within/i);

    fireEvent.change(input, { target: { value } });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Enter a whole number of days from 0 to 365.',
    );
    expect(putBodies()).toEqual([]);
  });

  it('meets the 44px tap-target contract on the input and buttons', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse({ defaultPaymentTermDays: 30 }));
    render(<PaymentTermsSheet onClose={() => {}} />);
    const input = await screen.findByLabelText(/Payment due within/i);

    expect(input.className).toContain('min-h-11');
    expect(screen.getByRole('button', { name: /^Save$/i }).className).toContain('min-h-11');
    expect(screen.getByRole('button', { name: /^Cancel$/i }).className).toContain('min-h-11');
    expect(screen.getByRole('button', { name: /^Close$/i }).className).toContain('size-11');
  });
});
