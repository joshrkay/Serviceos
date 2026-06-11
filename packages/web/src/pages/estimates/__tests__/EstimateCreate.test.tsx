import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router';
import { EstimateCreate } from '../EstimateCreate';

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
  { id: 'job-42', jobNumber: 'JOB-0042', summary: 'AC tune-up' },
  { id: 'job-7', jobNumber: 'JOB-0007', summary: 'Boiler service' },
];

describe('EstimateCreate (P11-006)', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
    vi.mocked(useListQuery).mockImplementation(((endpoint: string) => {
      if (endpoint === '/api/jobs') return listQueryResult(mockJobs);
      return listQueryResult([]);
    }) as never);
  });

  it('renders form with line item editor and Job picker', () => {
    render(
      <MemoryRouter>
        <EstimateCreate />
      </MemoryRouter>
    );
    expect(screen.getByText('New Estimate')).toBeInTheDocument();
    expect(screen.getByTestId('line-item-editor')).toBeInTheDocument();
    expect(screen.getByText(/Job \*/)).toBeInTheDocument();
  });

  it('blocks submit when jobId is empty', async () => {
    const { container } = render(
      <MemoryRouter>
        <EstimateCreate />
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

  it('POSTs cents-based payload to /api/estimates', async () => {
    vi.mocked(apiFetch).mockImplementation(((url: string, init?: RequestInit) => {
      if (typeof url === 'string' && url.startsWith('/api/jobs/')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ id: 'job-42', jobNumber: 'JOB-0042', summary: 'AC tune-up' }),
        } as unknown as Response);
      }
      if (url === '/api/estimates' && init?.method === 'POST') {
        return Promise.resolve({
          ok: true,
          status: 201,
          json: async () => ({ id: 'est-1' }),
        } as unknown as Response);
      }
      return Promise.resolve({ ok: false, status: 404, json: async () => ({}) } as unknown as Response);
    }) as never);

    const { container } = render(
      <MemoryRouter>
        <EstimateCreate />
      </MemoryRouter>
    );

    // Job picker is the only required <select> on the form.
    const jobSelect = container.querySelector('select[required]') as HTMLSelectElement;
    fireEvent.change(jobSelect, { target: { value: 'job-42' } });

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
