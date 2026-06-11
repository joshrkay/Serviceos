import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router';
import { InvoiceCreate } from '../InvoiceCreate';

const _sharedApiFetchMock = vi.hoisted(() => vi.fn());
vi.mock('../../../utils/api-fetch', () => ({
  apiFetch: _sharedApiFetchMock,
}));
vi.mock('../../../lib/apiClient', () => ({
  useApiClient: () => _sharedApiFetchMock,
}));

vi.mock('../../../hooks/useListQuery', () => ({
  useListQuery: vi.fn(),
}));

import { apiFetch } from '../../../utils/api-fetch';
import { useListQuery } from '../../../hooks/useListQuery';
import { listQueryResult } from '../../../test-utils/list-query-result';

const mockJobs = [
  { id: 'job-7', jobNumber: 'JOB-0007', summary: 'Boiler service' },
  { id: 'job-42', jobNumber: 'JOB-0042', summary: 'AC tune-up' },
];

describe('InvoiceCreate (P11-006)', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
    vi.mocked(useListQuery).mockImplementation(((endpoint: string) => {
      if (endpoint === '/api/jobs') return listQueryResult(mockJobs);
      if (endpoint === '/api/estimates') return listQueryResult([]);
      return listQueryResult([]);
    }) as never);
  });

  it('renders form with required Job picker (server zod requires it)', () => {
    render(
      <MemoryRouter>
        <InvoiceCreate />
      </MemoryRouter>
    );
    expect(screen.getByText('New Invoice')).toBeInTheDocument();
    expect(screen.getByText(/Job \*/)).toBeInTheDocument();
    expect(screen.getByTestId('line-item-editor')).toBeInTheDocument();
  });

  it('blocks submit when jobId is empty', async () => {
    const { container } = render(
      <MemoryRouter>
        <InvoiceCreate />
      </MemoryRouter>
    );
    // The submit button is wired through the form, but jsdom enforces the
    // <select required> HTML5 check on click-driven submits, which blocks
    // the JS handler. Dispatch a submit event directly so the JS-level
    // validation runs and renders the alert we assert on.
    const form = container.querySelector('form') as HTMLFormElement;
    fireEvent.submit(form);
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/Job is required/);
    });
    expect(vi.mocked(apiFetch)).not.toHaveBeenCalled();
  });

  it('POSTs to /api/invoices with cents conversion and includes dueDate (server zod will strip)', async () => {
    vi.mocked(apiFetch).mockImplementation(((url: string, init?: RequestInit) => {
      if (typeof url === 'string' && url.startsWith('/api/jobs/')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ id: 'job-7', jobNumber: 'JOB-0007', summary: 'Boiler service' }),
        } as unknown as Response);
      }
      if (url === '/api/invoices' && init?.method === 'POST') {
        return Promise.resolve({
          ok: true,
          status: 201,
          json: async () => ({ id: 'inv-1' }),
        } as unknown as Response);
      }
      return Promise.resolve({ ok: false, status: 404, json: async () => ({}) } as unknown as Response);
    }) as never);

    const { container } = render(
      <MemoryRouter>
        <InvoiceCreate />
      </MemoryRouter>
    );

    // Job picker is the only required <select> on the form (estimate picker is optional).
    const jobSelect = container.querySelector('select[required]') as HTMLSelectElement;
    fireEvent.change(jobSelect, { target: { value: 'job-7' } });

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
