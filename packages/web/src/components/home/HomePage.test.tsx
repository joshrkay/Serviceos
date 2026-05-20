import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router';
import { HomePage } from './HomePage';

vi.mock('../../hooks/useListQuery', () => ({ useListQuery: vi.fn() }));

import { useListQuery } from '../../hooks/useListQuery';

const today = new Date().toISOString().split('T')[0];
const pastDate = '2026-01-01';

const mockJobs = [
  {
    id: 'j1',
    jobNumber: 'JOB-001',
    summary: 'Fix AC unit',
    status: 'scheduled',
    moneyState: 'estimate_sent',
    serviceType: 'HVAC',
    scheduledStart: `${today}T09:00:00Z`,
    customer: { id: 'c1', displayName: 'Alice Smith' },
    technician: { id: 't1', firstName: 'Carlos', lastName: 'Reyes', color: '#3B82F6' },
  },
  {
    id: 'j2',
    jobNumber: 'JOB-002',
    summary: 'Drain cleaning',
    status: 'in_progress',
    serviceType: 'Plumbing',
    scheduledStart: `${today}T11:00:00Z`,
    customer: { id: 'c2', displayName: 'Bob Jones' },
  },
];

const mockEstimates = [
  {
    id: 'e1',
    estimateNumber: 'EST-001',
    status: 'sent',
    totalCents: 150000,
    customer: { id: 'c1', displayName: 'Alice Smith' },
    sentAt: '2026-03-10T10:00:00Z',
  },
];

const mockLeads = [
  {
    id: 'l1',
    firstName: 'Dave',
    lastName: 'Brown',
    stage: 'new',
    sourceDetail: 'Needs AC repair this summer',
    estimatedValueCents: 120_000,
    source: 'web_form',
  },
  {
    id: 'l2',
    firstName: 'Eve',
    lastName: 'Clark',
    stage: 'contacted',
    sourceDetail: 'Bathroom remodel',
    estimatedValueCents: 450_000,
    source: 'phone_call',
  },
];

const mockInvoices = [
  {
    id: 'inv1',
    invoiceNumber: 'INV-001',
    status: 'open',
    totalCents: 75000,
    customer: { id: 'c2', displayName: 'Bob Jones' },
    dueDate: pastDate,
  },
  {
    id: 'inv2',
    invoiceNumber: 'INV-002',
    status: 'open',
    totalCents: 50000,
    customer: { id: 'c3', displayName: 'Carol White' },
    dueDate: '2026-12-01',
  },
];

const makeListResult = (data: unknown[]) => ({
  data,
  total: data.length,
  page: 1,
  pageSize: 25,
  isLoading: false,
  error: null,
  refetch: vi.fn(),
  setPage: vi.fn(),
  setSearch: vi.fn(),
  setFilters: vi.fn(),
});

beforeEach(() => {
  vi.mocked(useListQuery).mockImplementation((path: string) => {
    if (path === '/api/jobs')      return makeListResult(mockJobs) as ReturnType<typeof useListQuery>;
    if (path === '/api/estimates') return makeListResult(mockEstimates) as ReturnType<typeof useListQuery>;
    if (path === '/api/invoices')  return makeListResult(mockInvoices) as ReturnType<typeof useListQuery>;
    if (path === '/api/leads')     return makeListResult(mockLeads) as ReturnType<typeof useListQuery>;
    return makeListResult([]) as ReturnType<typeof useListQuery>;
  });
});

function renderPage() {
  return render(
    <MemoryRouter>
      <HomePage />
    </MemoryRouter>
  );
}

describe('HomePage', () => {
  it("renders today's jobs section", () => {
    renderPage();
    expect(screen.getByText("Today's jobs")).toBeInTheDocument();
    expect(screen.getAllByText('Alice Smith').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Bob Jones').length).toBeGreaterThan(0);
  });

  it('shows job money-state badge when moneyState is set', () => {
    renderPage();
    expect(screen.getByText('Estimate sent')).toBeInTheDocument();
  });

  it('renders leads from /api/leads', () => {
    renderPage();
    expect(screen.getByText('Lead pipeline')).toBeInTheDocument();
    expect(screen.getByText('Dave Brown')).toBeInTheDocument();
  });

  it('queries /api/leads with limit filter', () => {
    renderPage();
    expect(vi.mocked(useListQuery)).toHaveBeenCalledWith(
      '/api/leads',
      expect.objectContaining({ filters: expect.objectContaining({ limit: '50' }) }),
    );
  });

  it('renders pending estimates section', () => {
    renderPage();
    expect(screen.getByText('Pending estimates')).toBeInTheDocument();
    expect(screen.getAllByText('Alice Smith').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/EST-001/).length).toBeGreaterThan(0);
  });

  it('renders outstanding invoices section', () => {
    renderPage();
    expect(screen.getByText('Outstanding invoices')).toBeInTheDocument();
    expect(screen.getAllByText(/INV-001/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/INV-002/).length).toBeGreaterThan(0);
  });

  it('shows total outstanding amount', () => {
    renderPage();
    // totalCents = 75000 + 50000 = 125000 = $1250 (appears in stat bar + section header)
    expect(screen.getAllByText('$1,250').length).toBeGreaterThan(0);
  });

  it('renders quick actions', () => {
    renderPage();
    expect(screen.getByText('New job')).toBeInTheDocument();
    expect(screen.getByText('New estimate')).toBeInTheDocument();
    expect(screen.getByText('New invoice')).toBeInTheDocument();
    expect(screen.getByText('Schedule')).toBeInTheDocument();
  });

  it('queries /api/jobs with today scheduledDate filter', () => {
    renderPage();
    expect(vi.mocked(useListQuery)).toHaveBeenCalledWith(
      '/api/jobs',
      expect.objectContaining({ filters: expect.objectContaining({ scheduledDate: expect.any(String) }) })
    );
  });

  it('queries /api/estimates with sent filter', () => {
    renderPage();
    expect(vi.mocked(useListQuery)).toHaveBeenCalledWith(
      '/api/estimates',
      expect.objectContaining({ filters: expect.objectContaining({ status: 'sent' }) })
    );
  });

  it('queries /api/invoices with open filter', () => {
    renderPage();
    expect(vi.mocked(useListQuery)).toHaveBeenCalledWith(
      '/api/invoices',
      expect.objectContaining({ filters: expect.objectContaining({ status: 'open' }) })
    );
  });

  it('shows loading spinner for jobs when loading', () => {
    vi.mocked(useListQuery).mockImplementation((path: string) => {
      if (path === '/api/jobs') return { ...makeListResult([]), isLoading: true } as ReturnType<typeof useListQuery>;
      if (path === '/api/estimates') return makeListResult(mockEstimates) as ReturnType<typeof useListQuery>;
      if (path === '/api/invoices')  return makeListResult(mockInvoices) as ReturnType<typeof useListQuery>;
      return makeListResult([]) as ReturnType<typeof useListQuery>;
    });
    const { container } = renderPage();
    expect(container.querySelector('.animate-spin')).toBeInTheDocument();
  });

  it('shows needs attention section for overdue invoices', () => {
    renderPage();
    expect(screen.getAllByText('Needs attention').length).toBeGreaterThan(0);
    // Bob Jones has overdue invoice
    expect(screen.getAllByText(/Bob Jones/).length).toBeGreaterThan(0);
  });

  it('shows week strip section', () => {
    renderPage();
    expect(screen.getByText('This week')).toBeInTheDocument();
    expect(screen.getByText('TODAY')).toBeInTheDocument();
  });

  it('shows empty jobs state when no jobs', () => {
    vi.mocked(useListQuery).mockImplementation((path: string) => {
      if (path === '/api/jobs')      return makeListResult([]) as ReturnType<typeof useListQuery>;
      if (path === '/api/estimates') return makeListResult([]) as ReturnType<typeof useListQuery>;
      if (path === '/api/invoices')  return makeListResult([]) as ReturnType<typeof useListQuery>;
      return makeListResult([]) as ReturnType<typeof useListQuery>;
    });
    renderPage();
    expect(screen.getByText('No jobs scheduled today')).toBeInTheDocument();
  });

  // ── P20-004: Error states for authenticated data panels ──────────────────

  it('[P20-004] shows session-expired message when jobs query returns 401', () => {
    vi.mocked(useListQuery).mockImplementation((path: string) => {
      if (path === '/api/jobs') {
        return { ...makeListResult([]), error: 'HTTP 401' } as ReturnType<typeof useListQuery>;
      }
      if (path === '/api/estimates') return makeListResult(mockEstimates) as ReturnType<typeof useListQuery>;
      if (path === '/api/invoices')  return makeListResult(mockInvoices) as ReturnType<typeof useListQuery>;
      return makeListResult([]) as ReturnType<typeof useListQuery>;
    });
    renderPage();
    expect(screen.getAllByText('Session expired — please reload').length).toBeGreaterThan(0);
    expect(screen.queryByRole('img', { name: /spinner/ })).not.toBeInTheDocument();
  });

  it('[P20-004] shows session-expired message when estimates query returns 401', () => {
    vi.mocked(useListQuery).mockImplementation((path: string) => {
      if (path === '/api/jobs')      return makeListResult(mockJobs) as ReturnType<typeof useListQuery>;
      if (path === '/api/estimates') {
        return { ...makeListResult([]), error: 'HTTP 401' } as ReturnType<typeof useListQuery>;
      }
      if (path === '/api/invoices')  return makeListResult(mockInvoices) as ReturnType<typeof useListQuery>;
      return makeListResult([]) as ReturnType<typeof useListQuery>;
    });
    renderPage();
    expect(screen.getAllByText('Session expired — please reload').length).toBeGreaterThan(0);
  });

  it('[P20-004] shows session-expired message when invoices query returns 401', () => {
    vi.mocked(useListQuery).mockImplementation((path: string) => {
      if (path === '/api/jobs')      return makeListResult(mockJobs) as ReturnType<typeof useListQuery>;
      if (path === '/api/estimates') return makeListResult(mockEstimates) as ReturnType<typeof useListQuery>;
      if (path === '/api/invoices') {
        return { ...makeListResult([]), error: 'HTTP 401' } as ReturnType<typeof useListQuery>;
      }
      return makeListResult([]) as ReturnType<typeof useListQuery>;
    });
    renderPage();
    expect(screen.getAllByText('Session expired — please reload').length).toBeGreaterThan(0);
  });

  it('[P20-004] shows generic error message for non-401 jobs failure', () => {
    vi.mocked(useListQuery).mockImplementation((path: string) => {
      if (path === '/api/jobs') {
        return { ...makeListResult([]), error: 'HTTP 500' } as ReturnType<typeof useListQuery>;
      }
      if (path === '/api/estimates') return makeListResult(mockEstimates) as ReturnType<typeof useListQuery>;
      if (path === '/api/invoices')  return makeListResult(mockInvoices) as ReturnType<typeof useListQuery>;
      return makeListResult([]) as ReturnType<typeof useListQuery>;
    });
    renderPage();
    expect(screen.getByText("Couldn't load jobs — please try again")).toBeInTheDocument();
  });

  it('[P20-004] happy path: no error shown when all queries succeed', () => {
    renderPage();
    expect(screen.queryByText('Session expired — please reload')).not.toBeInTheDocument();
    expect(screen.queryByText(/Couldn't load/)).not.toBeInTheDocument();
    expect(screen.getByText("Today's jobs")).toBeInTheDocument();
    expect(screen.getAllByText('Alice Smith').length).toBeGreaterThan(0);
  });

  it('[P20-004] no infinite spinner when jobs query errors (loading exits)', () => {
    vi.mocked(useListQuery).mockImplementation((path: string) => {
      if (path === '/api/jobs') {
        return { ...makeListResult([]), isLoading: false, error: 'HTTP 401' } as ReturnType<typeof useListQuery>;
      }
      if (path === '/api/estimates') return makeListResult(mockEstimates) as ReturnType<typeof useListQuery>;
      if (path === '/api/invoices')  return makeListResult(mockInvoices) as ReturnType<typeof useListQuery>;
      return makeListResult([]) as ReturnType<typeof useListQuery>;
    });
    const { container } = renderPage();
    // Spinner inside the jobs section should not be present
    expect(container.querySelectorAll('.animate-spin')).toHaveLength(0);
    expect(screen.getAllByText('Session expired — please reload').length).toBeGreaterThan(0);
  });
});
