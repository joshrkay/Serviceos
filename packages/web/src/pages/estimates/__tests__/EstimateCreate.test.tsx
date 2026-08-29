import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router';
import { EstimateCreate } from '../EstimateCreate';

vi.mock('../../../utils/api-fetch', () => ({
  apiFetch: vi.fn(),
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

// ─── #876: /estimates/new consumes ?customerId= and ?jobId= ──────────────────

describe('EstimateCreate query-param prefill (#876)', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
    vi.mocked(useListQuery).mockImplementation(((endpoint: string) => {
      if (endpoint === '/api/jobs') return listQueryResult(mockJobs);
      return listQueryResult([]);
    }) as never);
  });

  it('?jobId= preselects the job and triggers the customer enrichment fetch', async () => {
    vi.mocked(apiFetch).mockImplementation(((url: string) => {
      if (typeof url === 'string' && url.startsWith('/api/jobs/')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            id: 'job-42',
            jobNumber: 'JOB-0042',
            summary: 'AC tune-up',
            customer: { id: 'cust-1', displayName: 'Alice Smith' },
          }),
        } as unknown as Response);
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: [] }) } as unknown as Response);
    }) as never);

    const { container } = render(
      <MemoryRouter initialEntries={['/estimates/new?jobId=job-42']}>
        <EstimateCreate />
      </MemoryRouter>
    );

    const jobSelect = container.querySelector('select[required]') as HTMLSelectElement;
    expect(jobSelect.value).toBe('job-42');
    await waitFor(() => {
      expect(vi.mocked(apiFetch)).toHaveBeenCalledWith('/api/jobs/job-42');
    });
    // The enrichment panel shows whose estimate this is.
    await waitFor(() => {
      expect(screen.getByText(/Alice Smith/)).toBeInTheDocument();
    });
  });

  // #876 review — the scoped dropdown alone never said WHO it was scoped
  // to; the deep link now fetches the customer and shows "For: <name>".
  it('?customerId= fetches the customer and renders the For: affordance', async () => {
    vi.mocked(apiFetch).mockImplementation(((url: string) => {
      if (url === '/api/customers/cust-1') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ id: 'cust-1', firstName: 'Alice', lastName: 'Smith' }),
        } as unknown as Response);
      }
      return Promise.resolve({ ok: false, status: 404, json: async () => ({}) } as unknown as Response);
    }) as never);

    render(
      <MemoryRouter initialEntries={['/estimates/new?customerId=cust-1']}>
        <EstimateCreate />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(vi.mocked(apiFetch)).toHaveBeenCalledWith('/api/customers/cust-1');
    });
    const affordance = await screen.findByTestId('scoped-customer');
    expect(affordance).toHaveTextContent('For: Alice Smith');
  });

  it('hides the For: affordance when the customer fetch fails (stale link)', async () => {
    vi.mocked(apiFetch).mockResolvedValue(
      { ok: false, status: 404, json: async () => ({}) } as unknown as Response,
    );
    render(
      <MemoryRouter initialEntries={['/estimates/new?customerId=cust-gone']}>
        <EstimateCreate />
      </MemoryRouter>
    );
    await waitFor(() => {
      expect(vi.mocked(apiFetch)).toHaveBeenCalledWith('/api/customers/cust-gone');
    });
    expect(screen.queryByTestId('scoped-customer')).not.toBeInTheDocument();
  });

  // #876 review — a ?jobId= beyond the first page of /api/jobs used to
  // leave the required Select rendering blank; the by-id fetch now injects
  // the job as a selectable option.
  it('?jobId= not in the listed page injects the fetched job into the Select', async () => {
    vi.mocked(apiFetch).mockImplementation(((url: string) => {
      if (url === '/api/jobs/job-99') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            id: 'job-99',
            jobNumber: 'JOB-0099',
            summary: 'Attic rewire',
            customer: { id: 'cust-2', displayName: 'Bob Jones' },
          }),
        } as unknown as Response);
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: [] }) } as unknown as Response);
    }) as never);

    const { container } = render(
      <MemoryRouter initialEntries={['/estimates/new?jobId=job-99']}>
        <EstimateCreate />
      </MemoryRouter>
    );

    const jobSelect = container.querySelector('select[required]') as HTMLSelectElement;
    await waitFor(() => {
      // The injected option renders and is the selected one — not a blank.
      expect(
        Array.from(jobSelect.options).some((o) => o.value === 'job-99'),
      ).toBe(true);
    });
    expect(jobSelect.value).toBe('job-99');
    expect(screen.getByText('JOB-0099 — Attic rewire')).toBeInTheDocument();
    // The first-page jobs are still offered alongside the injected one.
    expect(Array.from(jobSelect.options).some((o) => o.value === 'job-42')).toBe(true);
  });

  it('does not duplicate a deep-linked job that IS in the listed page', async () => {
    vi.mocked(apiFetch).mockImplementation(((url: string) => {
      if (url === '/api/jobs/job-42') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ id: 'job-42', jobNumber: 'JOB-0042', summary: 'AC tune-up' }),
        } as unknown as Response);
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: [] }) } as unknown as Response);
    }) as never);

    const { container } = render(
      <MemoryRouter initialEntries={['/estimates/new?jobId=job-42']}>
        <EstimateCreate />
      </MemoryRouter>
    );
    const jobSelect = container.querySelector('select[required]') as HTMLSelectElement;
    await waitFor(() => expect(jobSelect.value).toBe('job-42'));
    const occurrences = Array.from(jobSelect.options).filter((o) => o.value === 'job-42');
    expect(occurrences).toHaveLength(1);
  });

  it('?customerId= scopes the job list query to that customer', () => {
    render(
      <MemoryRouter initialEntries={['/estimates/new?customerId=cust-1']}>
        <EstimateCreate />
      </MemoryRouter>
    );
    expect(vi.mocked(useListQuery)).toHaveBeenCalledWith('/api/jobs', {
      filters: { customerId: 'cust-1' },
    });
    // With jobs present there is no empty state.
    expect(screen.queryByTestId('no-jobs-empty-state')).not.toBeInTheDocument();
  });

  it('renders an honest empty state linking to /jobs/new when the customer has no jobs', () => {
    vi.mocked(useListQuery).mockImplementation((() => listQueryResult([])) as never);
    render(
      <MemoryRouter initialEntries={['/estimates/new?customerId=cust-9']}>
        <EstimateCreate />
      </MemoryRouter>
    );

    const empty = screen.getByTestId('no-jobs-empty-state');
    expect(empty).toHaveTextContent(/no jobs yet/i);
    const link = screen.getByRole('link', { name: /create a job for this customer/i });
    expect(link).toHaveAttribute('href', '/jobs/new?customerId=cust-9');
    // 44px tap-target class contract (CLAUDE.md mobile rules).
    expect(link.className).toContain('min-h-11');
  });

  it('shows no empty state on a plain /estimates/new visit with no jobs', () => {
    vi.mocked(useListQuery).mockImplementation((() => listQueryResult([])) as never);
    render(
      <MemoryRouter initialEntries={['/estimates/new']}>
        <EstimateCreate />
      </MemoryRouter>
    );
    // Without a customer scope the blank dropdown is the pre-existing generic
    // state — the #876 message is specifically about the scoped deep link.
    expect(screen.queryByTestId('no-jobs-empty-state')).not.toBeInTheDocument();
  });
});
