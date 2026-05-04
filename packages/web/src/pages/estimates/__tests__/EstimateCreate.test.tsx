import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router';
import { EstimateCreate } from '../EstimateCreate';

vi.mock('../../../utils/api-fetch', () => ({
  apiFetch: vi.fn(),
}));

import { apiFetch } from '../../../utils/api-fetch';

describe('EstimateCreate (P11-006)', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
  });

  it('renders form with line item editor (P11-006 jobId is required)', () => {
    render(
      <MemoryRouter>
        <EstimateCreate />
      </MemoryRouter>
    );
    expect(screen.getByText('New Estimate')).toBeInTheDocument();
    expect(screen.getByTestId('line-item-editor')).toBeInTheDocument();
    expect(screen.getByText(/Job ID \*/)).toBeInTheDocument();
  });

  it('blocks submit when jobId is empty', async () => {
    render(
      <MemoryRouter>
        <EstimateCreate />
      </MemoryRouter>
    );
    fireEvent.click(screen.getByRole('button', { name: /create estimate/i }));
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/Job ID is required/);
    });
    expect(vi.mocked(apiFetch)).not.toHaveBeenCalled();
  });

  it('POSTs cents-based payload to /api/estimates', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({ id: 'est-1' }),
    } as unknown as Response);

    render(
      <MemoryRouter>
        <EstimateCreate />
      </MemoryRouter>
    );

    fireEvent.change(screen.getByPlaceholderText('job-id-uuid'), {
      target: { value: 'job-42' },
    });
    fireEvent.change(screen.getByLabelText('description-0'), {
      target: { value: 'Diagnostic' },
    });
    fireEvent.change(screen.getByLabelText('quantity-0'), {
      target: { value: '2' },
    });
    fireEvent.change(screen.getByLabelText('unit-price-0'), {
      target: { value: '49.99' },
    });

    fireEvent.click(screen.getByRole('button', { name: /create estimate/i }));

    await waitFor(() => {
      const postCall = vi
        .mocked(apiFetch)
        .mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'POST');
      expect(postCall).toBeDefined();
      expect(postCall![0]).toBe('/api/estimates');
      const body = JSON.parse((postCall![1] as RequestInit).body as string);
      expect(body.jobId).toBe('job-42');
      expect(body.lineItems).toHaveLength(1);
      expect(body.lineItems[0].unitPriceCents).toBe(4999);
      expect(body.lineItems[0].totalCents).toBe(9998);
      expect(body.lineItems[0].sortOrder).toBe(0);
    });
  });
});
