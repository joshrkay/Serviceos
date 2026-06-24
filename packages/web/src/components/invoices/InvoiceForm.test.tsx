import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InvoiceForm } from './InvoiceForm';

vi.mock('../../hooks/useListQuery', () => ({ useListQuery: vi.fn() }));
vi.mock('../../utils/api-fetch', () => ({ apiFetch: vi.fn() }));

import { useListQuery } from '../../hooks/useListQuery';
import { apiFetch } from '../../utils/api-fetch';

const jobs = [{ id: 'job-1', jobNumber: 'JOB-1', summary: 'Water heater swap' }];
const estimates = [
  { id: 'est-1', estimateNumber: 'EST-1', status: 'accepted', jobId: 'job-1', totals: { totalCents: 50000 } },
];

function listResult(data: unknown[]) {
  return { data, total: data.length, page: 1, pageSize: 25, isLoading: false, error: null, refetch: vi.fn(), setPage: vi.fn(), setSearch: vi.fn(), setFilters: vi.fn() };
}

function postBody() {
  const call = vi.mocked(apiFetch).mock.calls.find(
    (c) => c[0] === '/api/invoices' && (c[1] as RequestInit | undefined)?.method === 'POST',
  );
  return call ? JSON.parse((call[1] as RequestInit).body as string) : undefined;
}

describe('InvoiceForm (characterization, pre-kit-migration)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useListQuery).mockImplementation((url: string) =>
      url === '/api/jobs' ? listResult(jobs) : url === '/api/estimates' ? listResult(estimates) : listResult([]),
    );
    // Default: job-detail enrich GET succeeds (non-fatal either way); POST returns an id.
    vi.mocked(apiFetch).mockImplementation(async (url: string, opts?: RequestInit) => {
      if (url === '/api/invoices' && opts?.method === 'POST') {
        return { ok: true, status: 201, json: async () => ({ id: 'inv-1' }) } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => jobs[0] } as unknown as Response;
    });
  });

  it('renders the job + estimate selectors from the list queries', () => {
    render(<InvoiceForm />);
    expect(screen.getByRole('option', { name: /JOB-1/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /EST-1/ })).toBeInTheDocument();
  });

  it('POSTs /api/invoices with integer-cents line items, discount, and tax', async () => {
    const onCreated = vi.fn();
    render(<InvoiceForm onCreated={onCreated} />);

    // Select a job (2nd combobox; the 1st is the estimate picker).
    fireEvent.change(screen.getAllByRole('combobox')[1], { target: { value: 'job-1' } });
    // Fill the single line item (LineItemEditor row 0).
    fireEvent.change(screen.getByLabelText('description-0'), { target: { value: 'Labor' } });
    fireEvent.change(screen.getByLabelText('unit-price-0'), { target: { value: '125.50' } });
    // Money knobs convert dollars/percent → integer cents/bps.
    fireEvent.change(screen.getByLabelText(/Discount/), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText(/Tax rate/), { target: { value: '8.25' } });

    fireEvent.click(screen.getByRole('button', { name: /create invoice/i }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('inv-1'));
    const body = postBody();
    expect(body.jobId).toBe('job-1');
    expect(body.lineItems[0].unitPriceCents).toBe(12550);
    expect(body.lineItems[0].totalCents).toBe(12550);
    expect(Number.isInteger(body.lineItems[0].unitPriceCents)).toBe(true);
    expect(body.discountCents).toBe(1000); // $10 → 1000 cents
    expect(body.taxRateBps).toBe(825); // 8.25% → 825 bps
  });

  it('creates no invoice when no job is selected (required job gates submission)', () => {
    render(<InvoiceForm />);
    fireEvent.change(screen.getByLabelText('description-0'), { target: { value: 'Labor' } });
    fireEvent.click(screen.getByRole('button', { name: /create invoice/i }));
    // The required job <select> blocks submission, so no invoice is POSTed.
    expect(vi.mocked(apiFetch).mock.calls.some((c) => c[0] === '/api/invoices')).toBe(false);
  });
});
