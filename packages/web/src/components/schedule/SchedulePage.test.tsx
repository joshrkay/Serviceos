import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router';
import { SchedulePage } from './SchedulePage';

vi.mock('../../utils/api-fetch', () => ({ apiFetch: vi.fn() }));
vi.mock('../../data/mock-data', () => ({
  technicians: [
    { id: 't1', name: 'Carlos Reyes', initials: 'CR', color: '#3B82F6' },
    { id: 't2', name: 'Marcus Webb',  initials: 'MW', color: '#22C55E' },
    { id: 't3', name: 'Sarah Lin',    initials: 'SL', color: '#8B5CF6' },
  ],
  jobs: [],
}));

import { apiFetch } from '../../utils/api-fetch';

const today = new Date().toISOString().split('T')[0];

const apptCarlos = {
  id: 'a1',
  jobId: 'j1',
  scheduledStart: `${today}T09:00:00.000Z`,
  scheduledEnd:   `${today}T10:00:00.000Z`,
  status: 'scheduled',
  timezone: 'America/Chicago',
};
const apptMarcus = {
  id: 'a2',
  jobId: 'j2',
  scheduledStart: `${today}T11:00:00.000Z`,
  scheduledEnd:   `${today}T12:00:00.000Z`,
  status: 'scheduled',
  timezone: 'America/Chicago',
};

const jobCarlos = {
  id: 'j1',
  jobNumber: 'JOB-001',
  summary: 'Fix AC unit not cooling',
  serviceType: 'HVAC',
  assignedTechnicianId: 't1',
  customer: { id: 'c1', displayName: 'Alice Smith' },
};
const jobMarcus = {
  id: 'j2',
  jobNumber: 'JOB-002',
  summary: 'Drain cleaning',
  serviceType: 'Plumbing',
  assignedTechnicianId: 't2',
  customer: { id: 'c2', displayName: 'Bob Jones' },
};

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function mockSchedule(opts: { appointments?: unknown[]; appointmentsOk?: boolean } = {}) {
  const { appointments = [apptCarlos, apptMarcus], appointmentsOk = true } = opts;
  vi.mocked(apiFetch).mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith('/api/appointments')) {
      return appointmentsOk ? jsonResponse({ data: appointments }) : jsonResponse({}, 500);
    }
    if (url.startsWith('/api/jobs/j1')) return jsonResponse(jobCarlos);
    if (url.startsWith('/api/jobs/j2')) return jsonResponse(jobMarcus);
    return jsonResponse({});
  });
}

beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
  mockSchedule();
});

function renderPage() {
  return render(
    <MemoryRouter>
      <SchedulePage />
    </MemoryRouter>
  );
}

describe('SchedulePage', () => {
  it('renders enriched appointments after fetch', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Alice Smith')).toBeInTheDocument());
    expect(screen.getByText('Bob Jones')).toBeInTheDocument();
    expect(screen.getByText('Fix AC unit not cooling')).toBeInTheDocument();
    expect(screen.getByText('Drain cleaning')).toBeInTheDocument();
  });

  it('shows the appointment count in the header', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('2 appointments')).toBeInTheDocument());
  });

  it('renders the technician filter pills', () => {
    renderPage();
    expect(screen.getByText('All techs')).toBeInTheDocument();
    expect(screen.getAllByText('Carlos').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Marcus').length).toBeGreaterThan(0);
  });

  it('shows the empty state when no appointments are returned', async () => {
    mockSchedule({ appointments: [] });
    renderPage();
    await waitFor(() => expect(screen.getByText('No appointments')).toBeInTheDocument());
  });

  it('filters appointments by technician', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Bob Jones')).toBeInTheDocument());
    const carlosFilter = screen.getAllByRole('button', { name: /Carlos/i })[0];
    fireEvent.click(carlosFilter);
    await waitFor(() => expect(screen.queryByText('Bob Jones')).not.toBeInTheDocument());
    expect(screen.getByText('Alice Smith')).toBeInTheDocument();
  });

  it('refetches when navigating to the next day', async () => {
    renderPage();
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/appointments?fromDate=')
    ));
    const callsBefore = vi.mocked(apiFetch).mock.calls.filter(
      ([url]) => typeof url === 'string' && url.startsWith('/api/appointments?')
    ).length;
    const navButtons = screen.getAllByRole('button').filter(b => b.className.includes('size-8'));
    fireEvent.click(navButtons[1]);
    await waitFor(() => {
      const callsAfter = vi.mocked(apiFetch).mock.calls.filter(
        ([url]) => typeof url === 'string' && url.startsWith('/api/appointments?')
      ).length;
      expect(callsAfter).toBeGreaterThan(callsBefore);
    });
  });

  it('toggles the new appointment form', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Alice Smith')).toBeInTheDocument());
    const newBtn = screen.getByRole('button', { name: /New appointment/i });
    fireEvent.click(newBtn);
    expect(screen.getByPlaceholderText('paste job UUID')).toBeInTheDocument();
  });
});
