import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MemoryRouter } from 'react-router';
import { SchedulePage } from './SchedulePage';
import { dateKeyInTz, formatDateInTenantTz } from '../../utils/formatInTenantTz';

vi.mock('../../utils/api-fetch', () => ({ apiFetch: vi.fn() }));

const ROSTER = {
  technicians: [
    { id: 't1', name: 'Carlos Reyes', initials: 'CR', color: '#3B82F6' },
    { id: 't2', name: 'Marcus Webb', initials: 'MW', color: '#22C55E' },
    { id: 't3', name: 'Sarah Lin', initials: 'SL', color: '#8B5CF6' },
  ],
  isLoading: false,
  error: null,
};

vi.mock('../../hooks/useTechnicianRoster', () => ({
  useTechnicianRoster: () => ROSTER,
}));

const TECHNICIANS = [
  { id: 't1', firstName: 'Carlos', lastName: 'Reyes' },
  { id: 't2', firstName: 'Marcus', lastName: 'Webb' },
  { id: 't3', firstName: 'Sarah', lastName: 'Lin' },
];

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
    if (url.includes('/api/users')) {
      return mockResponse({ data: TECHNICIANS });
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

  it('exposes a Dispatch board entry point linking to /dispatch', async () => {
    renderPage();
    const link = await screen.findByRole('link', { name: /dispatch board/i });
    expect(link).toHaveAttribute('href', '/dispatch');
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

  it('shows error message when /api/appointments returns non-ok (500)', async () => {
    vi.mocked(apiFetch).mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/api/users')) return mockResponse({ data: TECHNICIANS });
      if (url.startsWith('/api/appointments?')) return mockResponse({}, false, 500);
      return mockResponse({});
    });
    renderPage();
    expect(await screen.findByText("Couldn't load appointments — please try again")).toBeInTheDocument();
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
      // toDate encodes the end of the selected day as UTC — may be TODAY or TODAY+1
      // depending on the local timezone offset, so we only verify the param is present.
      expect(url).toContain('toDate=');
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
    await waitFor(() => {
      expect(carlosFilter).toBeDefined();
    });
    fireEvent.click(carlosFilter!);

    await waitFor(() => {
      expect(screen.queryByText('Bob Jones')).not.toBeInTheDocument();
      expect(screen.getByText('Alice Smith')).toBeInTheDocument();
    });
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

  // ── P20-004: Error states for authenticated data panels ──────────────────

  it('[P20-004] shows session-expired message on 401 and does not leave spinner up', async () => {
    vi.mocked(apiFetch).mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/api/users')) return mockResponse({ data: TECHNICIANS });
      if (url.startsWith('/api/appointments?')) return mockResponse({}, false, 401);
      return mockResponse({});
    });
    renderPage();
    expect(await screen.findByText('Session expired — please reload')).toBeInTheDocument();
    expect(document.querySelector('.animate-spin')).not.toBeInTheDocument();
  });

  it('[P20-004] shows generic error message on non-401 failure (not 401)', async () => {
    vi.mocked(apiFetch).mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/api/users')) return mockResponse({ data: TECHNICIANS });
      if (url.startsWith('/api/appointments?')) return mockResponse({}, false, 503);
      return mockResponse({});
    });
    renderPage();
    expect(await screen.findByText("Couldn't load appointments — please try again")).toBeInTheDocument();
  });

  it('[P20-004] renders "Reload page" affordance alongside the session-expired message', async () => {
    vi.mocked(apiFetch).mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/api/users')) return mockResponse({ data: TECHNICIANS });
      if (url.startsWith('/api/appointments?')) return mockResponse({}, false, 401);
      return mockResponse({});
    });
    renderPage();
    expect(await screen.findByText('Session expired — please reload')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reload page/i })).toBeInTheDocument();
  });

  it('[P20-004] happy path: loads data successfully without showing any error', async () => {
    renderPage();
    expect(await screen.findByText('Alice Smith')).toBeInTheDocument();
    expect(screen.queryByText('Session expired — please reload')).not.toBeInTheDocument();
    expect(screen.queryByText(/Couldn't load/)).not.toBeInTheDocument();
  });
});

// ─── Journey QA 2026-07-02 (bug 4): appointment times post in TENANT tz ──────

import { TenantTimezoneProvider } from '../../hooks/useTenantTimezone';

describe('journey QA bug 4 — new appointment posts tenant-tz-converted UTC', () => {
  it('14:00 entered for a New-York tenant posts 18:00Z (EDT), not 14:00Z', async () => {
    render(
      <MemoryRouter>
        <TenantTimezoneProvider overrideTimezone="America/New_York">
          <SchedulePage />
        </TenantTimezoneProvider>
      </MemoryRouter>,
    );
    await screen.findByText('Alice Smith');

    fireEvent.click(screen.getByRole('button', { name: /new appointment/i }));
    fireEvent.change(screen.getByPlaceholderText('paste job UUID'), {
      target: { value: 'j1' },
    });
    const timeInputs = document.querySelectorAll('input[type="time"]');
    fireEvent.change(timeInputs[0], { target: { value: '14:00' } });
    fireEvent.change(timeInputs[1], { target: { value: '16:00' } });
    fireEvent.click(screen.getByRole('button', { name: /create appointment/i }));

    await waitFor(() => {
      expect(
        vi
          .mocked(apiFetch)
          .mock.calls.some(([url, init]) => url === '/api/appointments' && init?.method === 'POST'),
      ).toBe(true);
    });
    const [, init] = vi
      .mocked(apiFetch)
      .mock.calls.find(([url, i]) => url === '/api/appointments' && i?.method === 'POST')!;
    const body = JSON.parse(String(init!.body));

    // May 2025 is EDT (UTC-4): 14:00 tenant wall clock = 18:00Z.
    expect(new Date(body.scheduledStart).getUTCHours()).toBe(18);
    expect(new Date(body.scheduledEnd).getUTCHours()).toBe(20);
    // The appointment's tz field carries the TENANT tz, not the browser's.
    expect(body.timezone).toBe('America/New_York');
  });
});

// ─── U8: day keys, day windows, and prev/next derive from the tenant tz ──────

const NY_TZ = 'America/New_York';

/** The date-part (in a tz) of the most recent /api/appointments query window. */
function latestQueryDayKey(tz: string): string {
  const calls = vi
    .mocked(apiFetch)
    .mock.calls.filter(([u]) => String(u).startsWith('/api/appointments?'));
  const url = String(calls[calls.length - 1][0]);
  const from = decodeURIComponent(url.match(/fromDate=([^&]+)/)![1]);
  return dateKeyInTz(from, tz);
}

function navButtons(): HTMLElement[] {
  return screen.getAllByRole('button').filter((b) => b.className.includes('size-8'));
}

describe('U8 — schedule day keys derive from the tenant tz', () => {
  it('selected chip date label matches the query-window day when browser tz ≠ tenant tz', async () => {
    // Near UTC midnight so the tenant calendar day (Sydney, UTC+10) diverges
    // from the UTC/browser day: 23:30Z May 20 is 09:30 May 21 in Sydney.
    vi.setSystemTime(new Date('2025-05-20T23:30:00Z'));
    render(
      <MemoryRouter>
        <TenantTimezoneProvider overrideTimezone="Australia/Sydney">
          <SchedulePage />
        </TenantTimezoneProvider>
      </MemoryRouter>,
    );

    let startUtc = '';
    await waitFor(() => {
      const calls = vi
        .mocked(apiFetch)
        .mock.calls.filter(([u]) => String(u).startsWith('/api/appointments?'));
      expect(calls.length).toBeGreaterThan(0);
      startUtc = decodeURIComponent(String(calls[calls.length - 1][0]).match(/fromDate=([^&]+)/)![1]);
    });

    // The day chip carries the tenant-tz label AND (post-fix) the tenant-tz key,
    // so the query window's day renders as the same "Mon D" label as the chip.
    const selectedChip = screen
      .getAllByRole('button')
      .find((b) => b.className.includes('min-w-[64px]') && b.className.includes('bg-slate-900'));
    expect(selectedChip).toBeDefined();
    const windowLabel = formatDateInTenantTz(startUtc, 'Australia/Sydney'); // e.g. "May 21"
    expect(selectedChip!.textContent).toContain(windowLabel);
  });

  it('prev/next cross the spring-forward DST day by exactly one calendar day (no skip/repeat)', async () => {
    vi.setSystemTime(new Date('2026-03-08T12:00:00Z')); // US spring forward, EST→EDT
    render(
      <MemoryRouter>
        <TenantTimezoneProvider overrideTimezone={NY_TZ}>
          <SchedulePage />
        </TenantTimezoneProvider>
      </MemoryRouter>,
    );
    await waitFor(() => expect(latestQueryDayKey(NY_TZ)).toBe('2026-03-08'));

    fireEvent.click(navButtons()[1]); // next → into EDT
    await waitFor(() => expect(latestQueryDayKey(NY_TZ)).toBe('2026-03-09'));
    fireEvent.click(navButtons()[0]); // prev → back onto the transition day
    await waitFor(() => expect(latestQueryDayKey(NY_TZ)).toBe('2026-03-08'));
    fireEvent.click(navButtons()[0]); // prev → the day before
    await waitFor(() => expect(latestQueryDayKey(NY_TZ)).toBe('2026-03-07'));
  });

  it('prev/next cross the fall-back DST day by exactly one calendar day (no skip/repeat)', async () => {
    vi.setSystemTime(new Date('2026-11-01T12:00:00Z')); // US fall back, EDT→EST
    render(
      <MemoryRouter>
        <TenantTimezoneProvider overrideTimezone={NY_TZ}>
          <SchedulePage />
        </TenantTimezoneProvider>
      </MemoryRouter>,
    );
    await waitFor(() => expect(latestQueryDayKey(NY_TZ)).toBe('2026-11-01'));

    fireEvent.click(navButtons()[1]); // next
    await waitFor(() => expect(latestQueryDayKey(NY_TZ)).toBe('2026-11-02'));
    fireEvent.click(navButtons()[0]); // prev
    await waitFor(() => expect(latestQueryDayKey(NY_TZ)).toBe('2026-11-01'));
    fireEvent.click(navButtons()[0]); // prev
    await waitFor(() => expect(latestQueryDayKey(NY_TZ)).toBe('2026-10-31'));
  });
});
