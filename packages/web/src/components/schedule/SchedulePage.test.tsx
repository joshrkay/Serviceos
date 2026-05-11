import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MemoryRouter } from 'react-router';
import { SchedulePage } from './SchedulePage';

vi.mock('../../utils/api-fetch', () => ({ apiFetch: vi.fn() }));
vi.mock('../../data/mock-data', () => ({
  technicians: [
    { id: 't1', name: 'Carlos Reyes', initials: 'CR', color: '#3B82F6' },
    { id: 't2', name: 'Marcus Webb',  initials: 'MW', color: '#22C55E' },
    { id: 't3', name: 'Sarah Lin',    initials: 'SL', color: '#8B5CF6' },
  ],
}));

import { apiFetch } from '../../utils/api-fetch';

// Pin the suite clock so date-window URL assertions are deterministic
// and the suite can't flake across a UTC day boundary.
const TODAY = '2025-05-20';
const PREV  = '2025-05-19';
const NEXT  = '2025-05-21';

const appt1 = {
  id: 'appt-1',
  jobId: 'j1',
  scheduledStart: `${TODAY}T09:00:00.000Z`,
  scheduledEnd: `${TODAY}T10:00:00.000Z`,
  status: 'scheduled',
  timezone: 'America/Chicago',
};

const appt2 = {
  id: 'appt-2',
  jobId: 'j2',
  scheduledStart: `${TODAY}T11:00:00.000Z`,
  scheduledEnd: `${TODAY}T12:00:00.000Z`,
  status: 'scheduled',
  timezone: 'America/Chicago',
};

const job1 = {
  id: 'j1',
  jobNumber: 'JOB-001',
  summary: 'Fix AC unit not cooling',
  serviceType: 'HVAC',
  assignedTechnicianId: 't1',
  customer: { displayName: 'Alice Smith' },
  location: { street1: '123 Main', city: 'Austin', state: 'TX' },
};

const job2 = {
  id: 'j2',
  jobNumber: 'JOB-002',
  summary: 'Drain cleaning',
  serviceType: 'Plumbing',
  assignedTechnicianId: 't2',
  customer: { displayName: 'Bob Jones' },
  location: { street1: '456 Oak', city: 'Austin', state: 'TX' },
};

function mockResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as Response;
}

/** Route apiFetch calls to the right mock body. */
function setupApi(appointments: unknown[] = [appt1, appt2], jobs: Record<string, unknown> = { j1: job1, j2: job2 }) {
  vi.mocked(apiFetch).mockImplementation(async (input) => {
    const url = String(input);
    if (url.startsWith('/api/appointments?')) {
      return mockResponse({ data: appointments });
    }
    const jobMatch = url.match(/^\/api\/jobs\/([^/?]+)/);
    if (jobMatch) {
      const job = jobs[jobMatch[1]];
      return job ? mockResponse(job) : mockResponse({}, false, 404);
    }
    return mockResponse({});
  });
}

beforeEach(() => {
  // shouldAdvanceTime keeps @testing-library's waitFor / findBy* polling
  // working under fake timers — without it those helpers hang.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date(`${TODAY}T12:00:00Z`));
  vi.clearAllMocks();
  setupApi();
});

afterEach(() => {
  vi.useRealTimers();
});

function renderPage() {
  return render(
    <MemoryRouter>
      <SchedulePage />
    </MemoryRouter>
  );
}

describe('SchedulePage', () => {
  it('renders appointments after fetching + enriching', async () => {
    renderPage();
    expect(await screen.findByText('Alice Smith')).toBeInTheDocument();
    expect(await screen.findByText('Bob Jones')).toBeInTheDocument();
  });

  it('renders enriched job summaries', async () => {
    renderPage();
    expect(await screen.findByText('Fix AC unit not cooling')).toBeInTheDocument();
    expect(await screen.findByText('Drain cleaning')).toBeInTheDocument();
  });

  it('shows appointment count after load', async () => {
    renderPage();
    expect(await screen.findByText('2 appointments')).toBeInTheDocument();
  });

  it('renders service address from job location', async () => {
    renderPage();
    expect(await screen.findByText('123 Main, Austin, TX')).toBeInTheDocument();
    expect(await screen.findByText('456 Oak, Austin, TX')).toBeInTheDocument();
  });

  it('shows empty state when no appointments', async () => {
    setupApi([]);
    renderPage();
    expect(await screen.findByText('No appointments')).toBeInTheDocument();
  });

  it('falls back gracefully when /api/appointments returns non-ok', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(mockResponse({}, false, 500));
    renderPage();
    expect(await screen.findByText('No appointments')).toBeInTheDocument();
  });

  it('uses fallback customer label when /api/jobs/:id fails', async () => {
    setupApi([appt1], {}); // no job data → /api/jobs/j1 returns 404
    renderPage();
    expect(await screen.findByText('Customer')).toBeInTheDocument();
  });

  it('calls /api/appointments with the selected day window', async () => {
    renderPage();
    await waitFor(() => {
      const apptCall = vi.mocked(apiFetch).mock.calls.find(([u]) =>
        String(u).startsWith('/api/appointments?'),
      );
      expect(apptCall).toBeDefined();
      const url = String(apptCall![0]);
      expect(url).toContain(`fromDate=${TODAY}`);
      expect(url).toContain(`toDate=${TODAY}`);
      expect(url).toContain('sort=asc');
    });
  });

  it('enriches each appointment via /api/jobs/:id', async () => {
    renderPage();
    await waitFor(() => {
      const calls = vi.mocked(apiFetch).mock.calls.map(([u]) => String(u));
      expect(calls).toContain('/api/jobs/j1');
      expect(calls).toContain('/api/jobs/j2');
    });
  });

  it('prev button reloads with an earlier date window', async () => {
    renderPage();
    await screen.findByText('Alice Smith');
    vi.mocked(apiFetch).mockClear();
    setupApi();

    const navButtons = screen.getAllByRole('button').filter(b =>
      b.className.includes('size-8'),
    );
    fireEvent.click(navButtons[0]); // ChevronLeft

    await waitFor(() => {
      const apptCall = vi.mocked(apiFetch).mock.calls.find(([u]) =>
        String(u).startsWith('/api/appointments?'),
      );
      expect(apptCall).toBeDefined();
      expect(String(apptCall![0])).toContain(`fromDate=${PREV}`);
    });
  });

  it('next button reloads with a later date window', async () => {
    renderPage();
    await screen.findByText('Alice Smith');
    vi.mocked(apiFetch).mockClear();
    setupApi();

    const navButtons = screen.getAllByRole('button').filter(b =>
      b.className.includes('size-8'),
    );
    fireEvent.click(navButtons[1]); // ChevronRight

    await waitFor(() => {
      const apptCall = vi.mocked(apiFetch).mock.calls.find(([u]) =>
        String(u).startsWith('/api/appointments?'),
      );
      expect(apptCall).toBeDefined();
      expect(String(apptCall![0])).toContain(`fromDate=${NEXT}`);
    });
  });

  it('tech filter hides appointments for other technicians', async () => {
    renderPage();
    expect(await screen.findByText('Alice Smith')).toBeInTheDocument();
    expect(screen.getByText('Bob Jones')).toBeInTheDocument();

    // The tech filter chip is a `rounded-full` pill containing the
    // tech's initials and first name (e.g. "CRCarlos" in textContent).
    const carlosFilter = screen
      .getAllByRole('button')
      .find(b => b.className.includes('rounded-full') && b.textContent?.endsWith('Carlos'));
    expect(carlosFilter).toBeDefined();
    fireEvent.click(carlosFilter!);

    expect(screen.queryByText('Bob Jones')).not.toBeInTheDocument();
    expect(screen.getByText('Alice Smith')).toBeInTheDocument();
  });

  it('flags overlapping appointments on the same technician as conflicts', async () => {
    // Two appointments on the same tech with overlapping times.
    const overlapAppt = {
      ...appt2,
      jobId: 'j1', // also Carlos (t1)
      scheduledStart: `${TODAY}T09:30:00.000Z`,
      scheduledEnd: `${TODAY}T10:30:00.000Z`,
    };
    setupApi([appt1, overlapAppt], { j1: job1 });
    renderPage();
    expect(await screen.findAllByText('Scheduling conflict')).toHaveLength(2);
    expect(screen.getByText(/2 scheduling conflicts today/)).toBeInTheDocument();
  });

  it('Notify delay button opens the delay sheet', async () => {
    renderPage();
    await screen.findByText('Alice Smith');
    const delayButtons = screen.getAllByRole('button', { name: /Notify delay/i });
    fireEvent.click(delayButtons[0]);
    expect(screen.getByText('Notify next customer of delay')).toBeInTheDocument();
  });

  it('Details button opens the detail modal', async () => {
    renderPage();
    await screen.findByText('Alice Smith');
    const detailsButtons = screen.getAllByRole('button', { name: 'Details' });
    fireEvent.click(detailsButtons[0]);
    expect(screen.getByText('Appointment details')).toBeInTheDocument();
  });
});
