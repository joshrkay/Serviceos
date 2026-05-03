import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router';
import { InvoiceCreate } from '../InvoiceCreate';

vi.mock('../../../utils/api-fetch', () => ({
  apiFetch: vi.fn(),
}));

import { apiFetch } from '../../../utils/api-fetch';

describe('InvoiceCreate (P11-006)', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
  });

  it('renders form with required jobId (server zod requires it)', () => {
    render(
      <MemoryRouter>
        <InvoiceCreate />
      </MemoryRouter>
    );
    expect(screen.getByText('New Invoice')).toBeInTheDocument();
    expect(screen.getByText(/Job ID \*/)).toBeInTheDocument();
    expect(screen.getByTestId('line-item-editor')).toBeInTheDocument();
  });

  it('blocks submit when jobId is empty', async () => {
    render(
      <MemoryRouter>
        <InvoiceCreate />
      </MemoryRouter>
    );
    fireEvent.click(screen.getByRole('button', { name: /create invoice/i }));
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/Job ID is required/);
    });
    expect(vi.mocked(apiFetch)).not.toHaveBeenCalled();
  });

  it('POSTs to /api/invoices with cents conversion and includes dueDate (server zod will strip)', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({ id: 'inv-1' }),
    } as unknown as Response);

    render(
      <MemoryRouter>
        <InvoiceCreate />
      </MemoryRouter>
    );

    // Job ID is the first text input on the form.
    fireEvent.change(screen.getByRole('textbox', { name: /Job ID/ }), {
      target: { value: 'job-7' },
    });
    fireEvent.change(screen.getByLabelText('description-0'), {
      target: { value: 'Service call' },
    });
    fireEvent.change(screen.getByLabelText('quantity-0'), {
      target: { value: '1' },
    });
    fireEvent.change(screen.getByLabelText('unit-price-0'), {
      target: { value: '125.00' },
    });

    fireEvent.click(screen.getByRole('button', { name: /create invoice/i }));

    await waitFor(() => {
      const postCall = vi
        .mocked(apiFetch)
        .mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'POST');
      expect(postCall).toBeDefined();
      expect(postCall![0]).toBe('/api/invoices');
      const body = JSON.parse((postCall![1] as RequestInit).body as string);
      expect(body.jobId).toBe('job-7');
      expect(body.lineItems[0].unitPriceCents).toBe(12500);
      expect(body.lineItems[0].totalCents).toBe(12500);
    });
  });
});
