import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router';
import { HomePage } from './HomePage';
import { todayInTz, tenantWallClockToUtc } from '../../utils/formatInTenantTz';

vi.mock('../../hooks/useListQuery', () => ({ useListQuery: vi.fn() }));

// U10 — "today" must be the tenant-tz calendar day. Mock the tz so the tests
// are deterministic regardless of the CI browser's zone.
vi.mock('../../hooks/useTenantTimezone', () => ({ useTenantTimezone: vi.fn(() => 'UTC') }));

vi.mock('./MoneyLoopHomeCard', () => ({
  MoneyLoopHomeCard: () => <div data-testid="money-loop-home-card" />,
}));

// Story 10.7 — unread replies surfacing. Default to none so existing tests are
// unaffected; individual tests override the resolved value.
vi.mock('../../api/conversations', () => ({
  listInboxThreads: vi.fn().mockResolvedValue([]),
}));

import { useListQuery } from '../../hooks/useListQuery';
import { useTenantTimezone } from '../../hooks/useTenantTimezone';
import { listInboxThreads } from '../../api/conversations';

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

// U10 — today's scheduled work comes from the appointments API (GET /api/jobs
// ignores scheduledDate). One appointment per mock job, dated today (UTC).
const mockAppointments = [
  { jobId: 'j1', scheduledStart: `${today}T09:00:00Z` },
  { jobId: 'j2', scheduledStart: `${today}T11:00:00Z` },
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
  vi.mocked(useTenantTimezone).mockReturnValue('UTC');
  vi.mocked(useListQuery).mockImplementation((path: string) => {
    if (path === '/api/appointments') return makeListResult(mockAppointments) as ReturnType<typeof useListQuery>;
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
  it('greets the signed-in user by first name (not a hardcoded demo name)', () => {
    renderPage();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/Ada/);
    expect(screen.queryByText(/Mike/)).toBeNull();
  });

  it('surfaces an unread customer reply as an attention item (Story 10.7)', async () => {
    vi.mocked(listInboxThreads).mockResolvedValueOnce([
      {
        conversation: {
          id: 'conv-1',
          status: 'open',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        lastMessageAt: new Date().toISOString(),
        lastMessagePreview: 'Is 2pm still good?',
        lastMessageDirection: 'inbound',
        needsReply: true,
        messageCount: 3,
        customerName: 'Dana Rivera',
      },
    ]);
    renderPage();
    expect(await screen.findByText('Dana Rivera replied')).toBeInTheDocument();
    expect(screen.getByText('Is 2pm still good?')).toBeInTheDocument();
  });

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

  it('renders money loop hub and conversational quick actions', () => {
    renderPage();
    expect(screen.getByTestId('money-loop-home-card')).toBeInTheDocument();
    // Epic 12.8 — quick actions open the conversational flow.
    expect(screen.getByText('Add customer')).toBeInTheDocument();
    expect(screen.getByText('Schedule')).toBeInTheDocument();
    expect(screen.getByText('New estimate')).toBeInTheDocument();
    expect(screen.getByText('New invoice')).toBeInTheDocument();
    const addCustomer = screen.getByText('Add customer').closest('button')!;
    expect(addCustomer).toBeInTheDocument();
  });

  it('queries /api/appointments with a fromDate/toDate day window (not the ignored jobs scheduledDate)', () => {
    renderPage();
    // U10 — GET /api/jobs ignores scheduledDate, so "today" is driven by the
    // appointments API's day window, keyed off the tenant tz.
    expect(vi.mocked(useListQuery)).toHaveBeenCalledWith(
      '/api/appointments',
      expect.objectContaining({
        filters: expect.objectContaining({
          fromDate: expect.any(String),
          toDate: expect.any(String),
        }),
      }),
    );
    // The jobs query no longer carries a (silently ignored) scheduledDate filter.
    const jobsCall = vi.mocked(useListQuery).mock.calls.find(([p]) => p === '/api/jobs');
    expect(jobsCall?.[1]?.filters ?? {}).not.toHaveProperty('scheduledDate');
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
    // Epic 12.9 — the empty state points to a first action (no dead end).
    expect(screen.getByText('No jobs scheduled today')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /schedule a job/i })).toBeInTheDocument();
  });

  it('[12.2] surfaces unassigned work with a path to the dispatch board', () => {
    // mockJobs j2 (Bob Jones) has no technician → counts as unassigned today.
    renderPage();
    const unassigned = screen.getByTestId('home-unassigned');
    expect(unassigned).toHaveTextContent(/1 unassigned job/i);
  });

  it('[12.2] passes a live refetch interval to the today queries', () => {
    renderPage();
    expect(vi.mocked(useListQuery)).toHaveBeenCalledWith(
      '/api/jobs',
      expect.objectContaining({ refetchInterval: expect.any(Number) }),
    );
    expect(vi.mocked(useListQuery)).toHaveBeenCalledWith(
      '/api/appointments',
      expect.objectContaining({ refetchInterval: expect.any(Number) }),
    );
  });

  // ── U10: today's jobs sourced from the appointments day window (tz-correct) ─

  it('[U10] renders a job in the today panel when its appointment is inside today (tenant tz)', () => {
    vi.mocked(useTenantTimezone).mockReturnValue('UTC');
    vi.mocked(useListQuery).mockImplementation((path: string) => {
      if (path === '/api/appointments') {
        return makeListResult([
          { jobId: 'j1', scheduledStart: `${todayInTz('UTC')}T14:00:00Z` },
        ]) as ReturnType<typeof useListQuery>;
      }
      if (path === '/api/jobs')      return makeListResult(mockJobs) as ReturnType<typeof useListQuery>;
      if (path === '/api/estimates') return makeListResult([]) as ReturnType<typeof useListQuery>;
      if (path === '/api/invoices')  return makeListResult([]) as ReturnType<typeof useListQuery>;
      return makeListResult([]) as ReturnType<typeof useListQuery>;
    });
    renderPage();
    const section = screen.getByText("Today's jobs").closest('section')!;
    expect(within(section).getByText('Alice Smith')).toBeInTheDocument();
    // j2 has no appointment today → it must not leak into the panel.
    expect(within(section).queryByText('Bob Jones')).toBeNull();
    expect(screen.queryByText('No jobs scheduled today')).toBeNull();
  });

  it('[U10] counts a 23:30 tenant-local appointment on the correct day when the browser tz differs', () => {
    // A late-evening appointment in a west-of-UTC tenant lands on the NEXT
    // calendar day in UTC. Keying "today" off the tenant tz (not the UTC date)
    // must still place it on the tenant's today.
    const zone = 'America/Los_Angeles';
    vi.mocked(useTenantTimezone).mockReturnValue(zone);
    const localToday = todayInTz(zone);
    const lateInstant = tenantWallClockToUtc(localToday, '23:30', zone).toISOString();
    // Sanity: the UTC calendar date of this instant is NOT the tenant's today —
    // a naive `toISOString().split('T')[0]` implementation would drop it.
    expect(lateInstant.slice(0, 10)).not.toBe(localToday);

    vi.mocked(useListQuery).mockImplementation((path: string) => {
      if (path === '/api/appointments') {
        return makeListResult([
          { jobId: 'j1', scheduledStart: lateInstant },
        ]) as ReturnType<typeof useListQuery>;
      }
      if (path === '/api/jobs')      return makeListResult(mockJobs) as ReturnType<typeof useListQuery>;
      if (path === '/api/estimates') return makeListResult([]) as ReturnType<typeof useListQuery>;
      if (path === '/api/invoices')  return makeListResult([]) as ReturnType<typeof useListQuery>;
      return makeListResult([]) as ReturnType<typeof useListQuery>;
    });
    renderPage();
    const section = screen.getByText("Today's jobs").closest('section')!;
    expect(within(section).getByText('Alice Smith')).toBeInTheDocument();
    expect(screen.queryByText('No jobs scheduled today')).toBeNull();
  });

  it('[U10] shows the empty state (not the full jobs list) when there are no appointments today', () => {
    vi.mocked(useTenantTimezone).mockReturnValue('UTC');
    vi.mocked(useListQuery).mockImplementation((path: string) => {
      // Jobs exist, but none are scheduled today (no appointments in window).
      if (path === '/api/appointments') return makeListResult([]) as ReturnType<typeof useListQuery>;
      if (path === '/api/jobs')      return makeListResult(mockJobs) as ReturnType<typeof useListQuery>;
      if (path === '/api/estimates') return makeListResult([]) as ReturnType<typeof useListQuery>;
      if (path === '/api/invoices')  return makeListResult([]) as ReturnType<typeof useListQuery>;
      return makeListResult([]) as ReturnType<typeof useListQuery>;
    });
    renderPage();
    const section = screen.getByText("Today's jobs").closest('section')!;
    expect(within(section).getByText('No jobs scheduled today')).toBeInTheDocument();
    // The full jobs list must NOT render just because /api/jobs returned rows.
    expect(within(section).queryByText('Alice Smith')).toBeNull();
    expect(within(section).queryByText('Bob Jones')).toBeNull();
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

  it('shows money-state badge on today job rows', () => {
    vi.mocked(useListQuery).mockImplementation((path: string) => {
      if (path === '/api/appointments') return makeListResult(mockAppointments) as ReturnType<typeof useListQuery>;
      if (path === '/api/jobs') {
        return makeListResult([
          { ...mockJobs[0], moneyState: 'estimate_sent' },
          { ...mockJobs[1], moneyState: 'overdue' },
        ]) as ReturnType<typeof useListQuery>;
      }
      if (path === '/api/estimates') return makeListResult(mockEstimates) as ReturnType<typeof useListQuery>;
      if (path === '/api/invoices') return makeListResult(mockInvoices) as ReturnType<typeof useListQuery>;
      return makeListResult([]) as ReturnType<typeof useListQuery>;
    });
    renderPage();
    expect(screen.getByText('Estimate sent')).toBeInTheDocument();
    expect(screen.getAllByText('Overdue').length).toBeGreaterThanOrEqual(1);
  });

  it('renders the populated dashboard on Path A tokens — no raw palette leaks', () => {
    const { container } = renderPage();
    // The today/estimates/invoices sections use divide-y between rows; pins
    // those (and everything else) to semantic tokens, not the slate palette.
    expect(container.innerHTML).not.toMatch(
      /(bg|text|border|border-l|border-t|placeholder|ring|divide|shadow)-(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}/,
    );
  });
});
