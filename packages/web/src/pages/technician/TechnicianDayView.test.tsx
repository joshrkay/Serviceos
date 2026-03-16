import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TechnicianDayView } from './TechnicianDayView';

describe('P6-019 — Technician day-of assigned-work view', () => {
  const mockAppointments = [
    {
      id: 'appt-2',
      jobId: 'job-2',
      customerName: 'Bob Wilson',
      locationAddress: '456 Oak Ave',
      scheduledStart: '2026-03-14T14:00:00Z',
      scheduledEnd: '2026-03-14T16:00:00Z',
      status: 'scheduled',
    },
    {
      id: 'appt-1',
      jobId: 'job-1',
      customerName: 'Jane Doe',
      locationAddress: '123 Main St',
      scheduledStart: '2026-03-14T09:00:00Z',
      scheduledEnd: '2026-03-14T11:00:00Z',
      status: 'confirmed',
      jobSummary: 'HVAC Repair',
    },
  ];

  beforeEach(() => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ appointments: mockAppointments }),
    });
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

  it('shows error state on fetch failure', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      statusText: 'Internal Server Error',
    });

    render(<TechnicianDayView technicianId="tech-1" />);

    expect(await screen.findByTestId('technician-day-error')).toBeInTheDocument();
  });

  it('shows empty state when no appointments', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ appointments: [] }),
    });

    render(<TechnicianDayView technicianId="tech-1" />);

    expect(await screen.findByTestId('technician-day-empty')).toBeInTheDocument();
    expect(screen.getByText('No appointments scheduled for today')).toBeInTheDocument();
  });
});
