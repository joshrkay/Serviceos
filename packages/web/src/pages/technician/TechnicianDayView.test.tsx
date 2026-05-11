import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router';
import { TechnicianDayView } from './TechnicianDayView';

// TechnicianDayView calls useNavigate() internally (per the merge that
// added job-detail navigation), so it requires a Router ancestor.
function renderWithRouter(ui: React.ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

describe('P6-019 — Technician day-of assigned-work view', () => {
  let onPositionSuccess: ((position: GeolocationPosition) => void) | null = null;

  const mockAppointments = [
    {
      id: 'appt-2',
      jobId: 'job-2',
      customerName: 'Bob Wilson',
      locationAddress: '456 Oak Ave',
      locationLatitude: 40.7155,
      locationLongitude: -74.0022,
      scheduledStart: '2026-03-14T14:00:00Z',
      scheduledEnd: '2026-03-14T16:00:00Z',
      status: 'scheduled',
    },
    {
      id: 'appt-1',
      jobId: 'job-1',
      customerName: 'Jane Doe',
      locationAddress: '123 Main St',
      locationLatitude: 40.7128,
      locationLongitude: -74.0060,
      scheduledStart: '2026-03-14T09:00:00Z',
      scheduledEnd: '2026-03-14T11:00:00Z',
      status: 'confirmed',
      jobSummary: 'HVAC Repair',
    },
  ];

  beforeEach(() => {
    vi.useRealTimers();

    Object.defineProperty(global.navigator, 'geolocation', {
      value: {
        watchPosition: vi.fn().mockImplementation((success: (position: GeolocationPosition) => void) => {
          onPositionSuccess = success;
          return 1;
        }),
        clearWatch: vi.fn(),
      },
      configurable: true,
    });

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ appointments: mockAppointments }),
    } as never);
  });

  it('renders the technician day view', async () => {
    render(<MemoryRouter><TechnicianDayView technicianId="tech-1" /></MemoryRouter>);
    expect(screen.getByTestId('technician-day-view')).toBeInTheDocument();
    expect(screen.getByText('My Schedule')).toBeInTheDocument();
  });

  it('shows loading state initially', () => {
    render(<MemoryRouter><TechnicianDayView technicianId="tech-1" /></MemoryRouter>);
    expect(screen.getByTestId('technician-day-loading')).toBeInTheDocument();
  });

  it('displays appointments after loading', async () => {
    render(<MemoryRouter><TechnicianDayView technicianId="tech-1" /></MemoryRouter>);

    const appointments = await screen.findAllByTestId('technician-day-appointment');
    expect(appointments).toHaveLength(2);
  });

  it('displays customer name and location', async () => {
    render(<MemoryRouter><TechnicianDayView technicianId="tech-1" /></MemoryRouter>);

    expect(await screen.findByText('Jane Doe')).toBeInTheDocument();
    expect(screen.getByText('123 Main St')).toBeInTheDocument();
    expect(screen.getByText('Bob Wilson')).toBeInTheDocument();
    expect(screen.getByText('456 Oak Ave')).toBeInTheDocument();
  });

  it('shows map link for next appointment', async () => {
    vi.setSystemTime(new Date('2026-03-14T08:00:00Z'));
    render(<MemoryRouter><TechnicianDayView technicianId="tech-1" /></MemoryRouter>);

    const link = await screen.findByTestId('technician-day-next-map-link');
    expect(link).toHaveAttribute('href', expect.stringContaining('google.com/maps'));
  });

  it('answers AI question about next appointment', async () => {
    vi.setSystemTime(new Date('2026-03-14T08:00:00Z'));
    render(<MemoryRouter><TechnicianDayView technicianId="tech-1" /></MemoryRouter>);

    await screen.findByText('Jane Doe');
    fireEvent.click(screen.getByTestId('technician-day-ask-ai'));

    expect(await screen.findByTestId('technician-day-ai-answer')).toHaveTextContent('Jane Doe');
  });

  it('allows editing appointment time', async () => {
    render(<MemoryRouter><TechnicianDayView technicianId="tech-1" /></MemoryRouter>);

    await screen.findByText('Jane Doe');
    fireEvent.click(screen.getAllByTestId('technician-day-edit')[0]);

    fireEvent.change(screen.getByTestId('technician-day-edit-start'), { target: { value: '2026-03-14T10:30' } });
    fireEvent.change(screen.getByTestId('technician-day-edit-end'), { target: { value: '2026-03-14T12:30' } });
    fireEvent.click(screen.getByTestId('technician-day-save'));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/appointments/appt-1'),
        expect.objectContaining({ method: 'PUT' })
      );
    });
  });

  it('shows error state on fetch failure', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      statusText: 'Internal Server Error',
    } as never);

    render(<MemoryRouter><TechnicianDayView technicianId="tech-1" /></MemoryRouter>);

    expect(await screen.findByTestId('technician-day-error')).toBeInTheDocument();
  });

  it('shows empty state when no appointments', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ appointments: [] }),
    } as never);

    render(<MemoryRouter><TechnicianDayView technicianId="tech-1" /></MemoryRouter>);

    expect(await screen.findByTestId('technician-day-empty')).toBeInTheDocument();
    expect(screen.getByText('No appointments scheduled for today')).toBeInTheDocument();
  });

  it('ignores low-accuracy GPS pings for lateness prompting', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-03-14T11:20:00Z'));
    render(<MemoryRouter><TechnicianDayView technicianId="tech-1" /></MemoryRouter>);
    await screen.findByText('Jane Doe');

    onPositionSuccess?.({
      coords: {
        latitude: 40.7128,
        longitude: -74.0060,
        accuracy: 150,
      } as GeolocationCoordinates,
      timestamp: Date.now(),
    } as GeolocationPosition);

    await vi.runOnlyPendingTimersAsync();
    expect(screen.queryByTestId('technician-day-delay-prompt')).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  it('escalates to dispatcher queue after technician response timeout', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-03-14T11:20:00Z'));
    render(<MemoryRouter><TechnicianDayView technicianId="tech-1" /></MemoryRouter>);
    await screen.findByText('Jane Doe');

    const staleBaseTime = Date.now() - (20 * 60 * 1000);
    for (let i = 0; i < 5; i += 1) {
      onPositionSuccess?.({
        coords: {
          latitude: 40.7128,
          longitude: -74.0060,
          accuracy: 20,
        } as GeolocationCoordinates,
        timestamp: staleBaseTime + (i * 1000),
      } as GeolocationPosition);
    }

    expect(await screen.findByTestId('technician-day-delay-prompt')).toBeInTheDocument();

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/dispatch/delay-escalations'),
        expect.objectContaining({ method: 'POST' })
      );
    });
    vi.useRealTimers();
  }, 15000);
});
