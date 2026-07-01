import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JobSchedulePanel } from './JobSchedulePanel';

vi.mock('../../utils/api-fetch', () => ({ apiFetch: vi.fn() }));
import { apiFetch } from '../../utils/api-fetch';

const APPT = {
  id: 'appt-1',
  scheduledStart: '2030-07-01T15:00:00.000Z',
  scheduledEnd: '2030-07-01T16:00:00.000Z',
  status: 'scheduled',
  idempotencyKey: 'job-schedule:job-1',
};

const ESTIMATE_APPT = {
  id: 'appt-est',
  scheduledStart: '2030-08-01T10:00:00.000Z',
  scheduledEnd: '2030-08-01T11:00:00.000Z',
  status: 'scheduled',
  idempotencyKey: 'from-estimate:est-1:auto:auto',
};

function mockApi(appointments: unknown[]) {
  vi.mocked(apiFetch).mockImplementation(async (url: RequestInfo | URL, opts?: RequestInit) => {
    const u = String(url);
    if (u.startsWith('/api/appointments')) {
      return { ok: true, status: 200, json: async () => appointments } as unknown as Response;
    }
    if (u.startsWith('/api/users')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [{ id: 'tech-9', firstName: 'Tess', lastName: 'Tech' }] }),
      } as unknown as Response;
    }
    if (opts?.method === 'POST') {
      return { ok: true, status: 200, json: async () => ({ id: 'job-1', status: 'scheduled' }) } as unknown as Response;
    }
    return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
  });
}

function postTo(path: string) {
  return vi
    .mocked(apiFetch)
    .mock.calls.find((c) => String(c[0]) === `/api/jobs/job-1${path}` && (c[1] as RequestInit | undefined)?.method === 'POST');
}
function postBody(path: string) {
  const call = postTo(path);
  return call ? JSON.parse((call[1] as RequestInit).body as string) : undefined;
}

describe('JobSchedulePanel (U8)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows the current schedule and meets the >=44px tap-target bar', async () => {
    mockApi([APPT]);
    render(<JobSchedulePanel jobId="job-1" assignedTechnicianId="tech-9" />);

    expect(await screen.findByTestId('current-schedule')).toHaveTextContent(/Scheduled for/);
    expect(screen.getByLabelText(/Reschedule start/)).toHaveClass('min-h-11');
    expect(screen.getByLabelText(/Technician/)).toHaveClass('min-h-11');
    expect(screen.getByRole('button', { name: 'Reschedule' })).toHaveClass('min-h-11');
    expect(screen.getByRole('button', { name: 'Unschedule' })).toHaveClass('min-h-11');
  });

  it('reschedule POSTs an ISO start (and keeps the tech) to /schedule', async () => {
    mockApi([APPT]);
    render(<JobSchedulePanel jobId="job-1" assignedTechnicianId="tech-9" />);
    await screen.findByTestId('current-schedule');

    fireEvent.change(screen.getByLabelText(/Reschedule start/), { target: { value: '2030-07-02T09:30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reschedule' }));

    await waitFor(() => expect(postTo('/schedule')).toBeTruthy());
    const body = postBody('/schedule');
    expect(body.scheduledStart).toMatch(/Z$/);
    expect(body.technicianId).toBe('tech-9');
  });

  it('reschedule does not send durationMin (server preserves the slot length)', async () => {
    mockApi([APPT]);
    render(<JobSchedulePanel jobId="job-1" assignedTechnicianId="tech-9" />);
    await screen.findByTestId('current-schedule');

    fireEvent.change(screen.getByLabelText(/Reschedule start/), { target: { value: '2030-07-02T09:30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reschedule' }));

    await waitFor(() => expect(postTo('/schedule')).toBeTruthy());
    expect(postBody('/schedule')).not.toHaveProperty('durationMin');
  });

  it('reassign to Unassigned sends technicianId null', async () => {
    mockApi([APPT]);
    render(<JobSchedulePanel jobId="job-1" assignedTechnicianId="tech-9" />);
    await screen.findByTestId('current-schedule');

    fireEvent.change(screen.getByLabelText(/Technician/), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reassign' }));

    await waitFor(() => expect(postTo('/reassign')).toBeTruthy());
    expect(postBody('/reassign').technicianId).toBeNull();
  });

  it('unschedule POSTs to /unschedule', async () => {
    mockApi([APPT]);
    render(<JobSchedulePanel jobId="job-1" />);
    await screen.findByTestId('current-schedule');

    fireEvent.click(screen.getByRole('button', { name: 'Unschedule' }));
    await waitFor(() => expect(postTo('/unschedule')).toBeTruthy());
  });

  it('shows "Not scheduled" and schedules a fresh appointment', async () => {
    mockApi([]);
    render(<JobSchedulePanel jobId="job-1" />);

    expect(await screen.findByTestId('current-schedule')).toHaveTextContent(/Not scheduled/);
    expect(screen.queryByRole('button', { name: 'Unschedule' })).toBeNull();

    fireEvent.change(screen.getByLabelText(/Start time/), { target: { value: '2030-07-01T15:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Schedule' }));

    await waitFor(() => expect(postTo('/schedule')).toBeTruthy());
    expect(postBody('/schedule').scheduledStart).toMatch(/Z$/);
  });

  it('scopes to the canonical job-schedule appointment, ignoring an estimate appointment', async () => {
    // Estimate appointment comes first in the list; the panel must skip it and
    // show the canonical job-schedule row.
    mockApi([ESTIMATE_APPT, APPT]);
    render(<JobSchedulePanel jobId="job-1" />);
    const current = await screen.findByTestId('current-schedule');
    // Canonical APPT is 2030-07-01, estimate is 2030-08-01 — must reflect the canonical one.
    expect(current).toHaveTextContent(/Scheduled for/);
    expect(current.textContent).not.toMatch(/8\/1\/2030|2030-08/);
  });

  it('does not present a started/finished canonical appointment as editable', async () => {
    mockApi([{ ...APPT, status: 'completed' }]);
    render(<JobSchedulePanel jobId="job-1" />);
    expect(await screen.findByTestId('current-schedule')).toHaveTextContent(/Not scheduled/);
    expect(screen.queryByRole('button', { name: 'Reschedule' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Unschedule' })).toBeNull();
  });

  it('treats a job with only an estimate appointment as not directly scheduled', async () => {
    mockApi([ESTIMATE_APPT]);
    render(<JobSchedulePanel jobId="job-1" />);
    expect(await screen.findByTestId('current-schedule')).toHaveTextContent(/Not scheduled/);
    expect(screen.queryByRole('button', { name: 'Unschedule' })).toBeNull();
  });

  it('clears the technician dropdown when the job tech becomes undefined', async () => {
    mockApi([APPT]);
    const { rerender } = render(<JobSchedulePanel jobId="job-1" assignedTechnicianId="tech-9" />);
    await screen.findByTestId('current-schedule');
    expect((screen.getByLabelText(/Technician/) as HTMLSelectElement).value).toBe('tech-9');

    // After a reassign-to-Unassigned + parent refetch, the prop clears.
    rerender(<JobSchedulePanel jobId="job-1" assignedTechnicianId={undefined} />);
    expect((screen.getByLabelText(/Technician/) as HTMLSelectElement).value).toBe('');
  });
});
