import React from 'react';
import { fireEvent, render as rtlRender, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router';
import { TechnicianDayView, answerScheduleQuestion } from './TechnicianDayView';
import { TenantTimezoneProvider } from '../../hooks/useTenantTimezone';

// TechnicianDayView now uses useNavigate() so all renders need a router.
function render(ui: React.ReactElement) {
  return rtlRender(<MemoryRouter>{ui}</MemoryRouter>);
}

// Renders inside a pinned tenant timezone (bypasses the /api/me fetch via the
// provider's overrideTimezone test seam).
function renderWithTz(ui: React.ReactElement, timezone: string) {
  return rtlRender(
    <TenantTimezoneProvider overrideTimezone={timezone}>
      <MemoryRouter>{ui}</MemoryRouter>
    </TenantTimezoneProvider>,
  );
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
      updatedAt: '2026-03-13T08:00:00Z',
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
    render(<TechnicianDayView technicianId="tech-1" />);
    expect(screen.getByTestId('technician-day-view')).toBeInTheDocument();
    expect(screen.getByText('My Schedule')).toBeInTheDocument();
  });

  it('shows loading state initially', () => {
    render(<TechnicianDayView technicianId="tech-1" />);
    expect(screen.getByTestId('technician-day-loading')).toBeInTheDocument();
  });

  it('displays appointments after loading', async () => {
    render(<TechnicianDayView technicianId="tech-1" />);

    const appointments = await screen.findAllByTestId('technician-day-appointment');
    expect(appointments).toHaveLength(2);
  });

  it('displays customer name and location', async () => {
    render(<TechnicianDayView technicianId="tech-1" />);

    expect(await screen.findByText('Jane Doe')).toBeInTheDocument();
    expect(screen.getByText('123 Main St')).toBeInTheDocument();
    expect(screen.getByText('Bob Wilson')).toBeInTheDocument();
    expect(screen.getByText('456 Oak Ave')).toBeInTheDocument();
  });

  it('shows map link for next appointment', async () => {
    vi.setSystemTime(new Date('2026-03-14T08:00:00Z'));
    render(<TechnicianDayView technicianId="tech-1" />);

    const link = await screen.findByTestId('technician-day-next-map-link');
    expect(link).toHaveAttribute('href', expect.stringContaining('google.com/maps'));
  });

  it('answers AI question about next appointment', async () => {
    vi.setSystemTime(new Date('2026-03-14T08:00:00Z'));
    render(<TechnicianDayView technicianId="tech-1" />);

    await screen.findByText('Jane Doe');
    fireEvent.click(screen.getByTestId('technician-day-ask-ai'));

    expect(await screen.findByTestId('technician-day-ai-answer')).toHaveTextContent('Jane Doe');
  });

  it('routes an edit through a reschedule_appointment proposal, not a direct PUT', async () => {
    render(<TechnicianDayView technicianId="tech-1" />);

    await screen.findByText('Jane Doe');
    fireEvent.click(screen.getAllByTestId('technician-day-edit')[0]);

    fireEvent.change(screen.getByTestId('technician-day-edit-start'), { target: { value: '2026-03-14T10:30' } });
    fireEvent.change(screen.getByTestId('technician-day-edit-end'), { target: { value: '2026-03-14T12:30' } });
    fireEvent.click(screen.getByTestId('technician-day-save'));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/proposals'),
        expect.objectContaining({ method: 'POST' })
      );
    });

    const proposalCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('/api/proposals')
    );
    expect(proposalCall).toBeTruthy();
    const init = proposalCall![1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.proposalType).toBe('reschedule_appointment');
    expect(body.payload.appointmentId).toBe('appt-1');
    expect(body.payload.newScheduledStart).toBe(new Date('2026-03-14T10:30').toISOString());
    expect(body.payload.newScheduledEnd).toBe(new Date('2026-03-14T12:30').toISOString());
    expect(body.appointmentVersion).toBe('2026-03-13T08:00:00Z');
    expect((init.headers as Record<string, string>)['If-Match']).toBe('2026-03-13T08:00:00Z');

    // Never falls back to the appointments:update PUT path (which would 403 for a tech).
    const putCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) =>
        typeof call[0] === 'string' &&
        call[0].includes('/api/appointments/appt-1') &&
        (call[1] as RequestInit)?.method === 'PUT'
    );
    expect(putCall).toBeUndefined();
  });

  it('surfaces a proposal submission failure', async () => {
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/api/proposals')) {
        return Promise.resolve({ ok: false, status: 500, text: () => Promise.resolve('boom') } as never);
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ appointments: mockAppointments }) } as never);
    });

    render(<TechnicianDayView technicianId="tech-1" />);
    await screen.findByText('Jane Doe');
    fireEvent.click(screen.getAllByTestId('technician-day-edit')[0]);
    fireEvent.change(screen.getByTestId('technician-day-edit-start'), { target: { value: '2026-03-14T10:30' } });
    fireEvent.change(screen.getByTestId('technician-day-edit-end'), { target: { value: '2026-03-14T12:30' } });
    fireEvent.click(screen.getByTestId('technician-day-save'));

    expect(await screen.findByTestId('technician-day-error')).toBeInTheDocument();
  });

  it('offers a refresh affordance on a 409 conflict', async () => {
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/api/proposals')) {
        return Promise.resolve({ ok: false, status: 409, json: () => Promise.resolve({}) } as never);
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ appointments: mockAppointments }) } as never);
    });

    render(<TechnicianDayView technicianId="tech-1" />);
    await screen.findByText('Jane Doe');
    fireEvent.click(screen.getAllByTestId('technician-day-edit')[0]);
    fireEvent.change(screen.getByTestId('technician-day-edit-start'), { target: { value: '2026-03-14T10:30' } });
    fireEvent.change(screen.getByTestId('technician-day-edit-end'), { target: { value: '2026-03-14T12:30' } });
    fireEvent.click(screen.getByTestId('technician-day-save'));

    expect(await screen.findByTestId('technician-day-refresh')).toBeInTheDocument();
    expect(screen.getByTestId('technician-day-error')).toBeInTheDocument();
  });

  it('catches a running-late notification failure instead of dropping it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-03-14T11:20:00Z'));

    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/running-late')) {
        return Promise.reject(new Error('network down'));
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ appointments: mockAppointments }) } as never);
    });

    render(<TechnicianDayView technicianId="tech-1" />);
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

    // The delay prompt requires a technician decision; accepting triggers the
    // running-late notice call, whose failure must be caught and surfaced.
    const prompt = await screen.findByTestId('technician-day-delay-prompt');
    expect(prompt).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('technician-day-delay-accept'));

    await waitFor(() => {
      expect(screen.getByTestId('technician-day-error')).toBeInTheDocument();
    });
    vi.useRealTimers();
  }, 15000);

  it('delay-prompt Accept POSTs to the running-late endpoint, never the 403ing PUT', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-03-14T11:20:00Z'));

    render(<TechnicianDayView technicianId="tech-1" />);
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
    fireEvent.click(screen.getByTestId('technician-day-delay-accept'));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/appointments/appt-1/running-late'),
        expect.objectContaining({ method: 'POST' })
      );
    });

    // Technicians don't hold appointments:update — a direct PUT would 403.
    const putCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) =>
        typeof call[0] === 'string' &&
        call[0].includes('/api/appointments/') &&
        (call[1] as RequestInit)?.method === 'PUT'
    );
    expect(putCall).toBeUndefined();
    vi.useRealTimers();
  }, 15000);

  it('shows error state on fetch failure', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      statusText: 'Internal Server Error',
    } as never);

    render(<TechnicianDayView technicianId="tech-1" />);

    expect(await screen.findByTestId('technician-day-error')).toBeInTheDocument();
  });

  it('shows empty state when no appointments', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ appointments: [] }),
    } as never);

    render(<TechnicianDayView technicianId="tech-1" />);

    expect(await screen.findByTestId('technician-day-empty')).toBeInTheDocument();
    expect(screen.getByText('No appointments scheduled for today')).toBeInTheDocument();
  });

  it('ignores low-accuracy GPS pings for lateness prompting', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-03-14T11:20:00Z'));
    render(<TechnicianDayView technicianId="tech-1" />);
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
    render(<TechnicianDayView technicianId="tech-1" />);
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

  // Sweep-2 S3 — the view used to ship BEM class names with no stylesheet
  // (inert in this Tailwind app): unstyled text, fused buttons, tap targets
  // far below the repo's ≥44px mobile rule. Class-contract pin per
  // CLAUDE.md (pattern: EstimateApprovalPage.layout.test.tsx).
  describe('mobile styling contract (sweep-2 S3)', () => {
    it('all interactive controls meet the 44px tap target (min-h-11)', async () => {
      render(<TechnicianDayView technicianId="tech-1" />);
      await screen.findByText('Jane Doe');

      const buttons = [
        screen.getByTestId('technician-day-prev'),
        screen.getByTestId('technician-day-next'),
        screen.getByTestId('technician-day-ask-ai'),
        ...screen.getAllByTestId('technician-day-view-job'),
        ...screen.getAllByTestId('technician-day-on-my-way'),
        ...screen.getAllByTestId('technician-day-edit'),
      ];
      expect(buttons.length).toBeGreaterThanOrEqual(6);
      for (const button of buttons) {
        expect(button.className).toContain('min-h-11');
      }
    });

    it('edit-form inputs and actions meet the 44px tap target too', async () => {
      render(<TechnicianDayView technicianId="tech-1" />);
      await screen.findByText('Jane Doe');

      fireEvent.click(screen.getAllByTestId('technician-day-edit')[0]);

      expect(screen.getByTestId('technician-day-edit-start').className).toContain('min-h-11');
      expect(screen.getByTestId('technician-day-edit-end').className).toContain('min-h-11');
      expect(screen.getByTestId('technician-day-save').className).toContain('min-h-11');
      expect(screen.getByTestId('technician-day-cancel').className).toContain('min-h-11');
    });

    it('appointments render as styled cards (no inert BEM classes anywhere)', async () => {
      const { container } = render(<TechnicianDayView technicianId="tech-1" />);
      await screen.findByText('Jane Doe');

      const card = screen.getAllByTestId('technician-day-appointment')[0];
      expect(card.className).toContain('rounded-2xl');
      expect(card.className).toContain('border');
      // No leftover technician-day-view__* BEM classes (they had no stylesheet).
      expect(container.querySelector('[class*="technician-day-view__"]')).toBeNull();
    });
  });

  // Finding 4 (WS6) — appointment times were rendered with
  // `new Date(iso).toLocaleTimeString()` (browser-local), so the same instant
  // showed a different wall clock for every viewer. They must render in the
  // TENANT timezone, deterministically, regardless of the JS runtime timezone
  // (CLAUDE.md: "stored UTC, rendered in tenant timezone").
  describe('tenant-timezone date rendering', () => {
    // 2026-03-14T14:00:00Z: after US DST start (2026-03-08), so NY is EDT
    // (UTC-4) and LA is PDT (UTC-7).
    const startZ = '2026-03-14T14:00:00Z';

    it('answerScheduleQuestion formats the next-appointment time in the tenant tz (NY)', () => {
      const appts = [
        { ...mockAppointments[0], scheduledStart: startZ },
      ];
      const answer = answerScheduleQuestion(
        'Where is my next appointment?',
        appts,
        new Date('2026-03-14T00:00:00Z'),
        'America/New_York',
      );
      // 14:00Z is 10:00 AM in New York — NOT the process-local wall clock.
      expect(answer).toContain('10:00 AM');
    });

    it('answerScheduleQuestion renders the SAME instant differently under a different tenant tz (LA)', () => {
      const appts = [
        { ...mockAppointments[0], scheduledStart: startZ },
      ];
      const answer = answerScheduleQuestion(
        'Where is my next appointment?',
        appts,
        new Date('2026-03-14T00:00:00Z'),
        'America/Los_Angeles',
      );
      // Same instant, LA (UTC-7) → 7:00 AM. Proves the output tracks the tenant
      // tz argument, not the browser/process timezone.
      expect(answer).toContain('7:00 AM');
    });

    it('renders appointment time rows in the tenant timezone (NY), independent of process TZ', async () => {
      renderWithTz(<TechnicianDayView technicianId="tech-1" />, 'America/New_York');

      await screen.findByText('Jane Doe');

      // appt-1: 09:00Z–11:00Z EDT → 5:00 AM – 7:00 AM.
      // appt-2: 14:00Z–16:00Z EDT → 10:00 AM – 12:00 PM.
      const times = screen.getAllByTestId('technician-day-time').map((el) => el.textContent);
      expect(times).toContain('5:00 AM - 7:00 AM');
      expect(times).toContain('10:00 AM - 12:00 PM');
    });
  });
});
