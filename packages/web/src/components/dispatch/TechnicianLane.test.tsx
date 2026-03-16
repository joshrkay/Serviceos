import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { TechnicianLane } from './TechnicianLane';
import { AppointmentCardData } from './AppointmentCard';

describe('P6-004 — Technician lanes', () => {
  const technician = { id: 'tech-1', name: 'John Smith' };

  const appointments: AppointmentCardData[] = [
    {
      id: 'appt-2',
      jobId: 'job-2',
      customerName: 'Bob Wilson',
      locationAddress: '456 Oak Ave',
      jobSummary: 'Plumbing',
      scheduledStart: '2026-03-14T14:00:00Z',
      scheduledEnd: '2026-03-14T16:00:00Z',
      status: 'scheduled',
    },
    {
      id: 'appt-1',
      jobId: 'job-1',
      customerName: 'Jane Doe',
      locationAddress: '123 Main St',
      jobSummary: 'HVAC Repair',
      scheduledStart: '2026-03-14T09:00:00Z',
      scheduledEnd: '2026-03-14T11:00:00Z',
      status: 'confirmed',
    },
  ];

  it('renders technician lane with header', () => {
    render(<TechnicianLane technician={technician} appointments={appointments} />);
    expect(screen.getByTestId('technician-lane')).toBeInTheDocument();
    expect(screen.getByText('John Smith')).toBeInTheDocument();
  });

  it('shows appointment count', () => {
    render(<TechnicianLane technician={technician} appointments={appointments} />);
    expect(screen.getByTestId('technician-lane-count')).toHaveTextContent('2');
  });

  it('sorts appointments by scheduled start time', () => {
    render(<TechnicianLane technician={technician} appointments={appointments} />);
    const cards = screen.getAllByTestId('appointment-card');
    expect(cards).toHaveLength(2);
    // First card should be the earlier appointment (Jane Doe at 09:00)
    expect(screen.getByText('Jane Doe')).toBeInTheDocument();
  });

  it('shows empty lane message when no appointments', () => {
    render(<TechnicianLane technician={technician} appointments={[]} />);
    expect(screen.getByTestId('technician-lane-empty')).toBeInTheDocument();
    expect(screen.getByText('No appointments')).toBeInTheDocument();
  });

  it('applies drag-over class when isDragOver', () => {
    render(<TechnicianLane technician={technician} appointments={[]} isDragOver={true} />);
    const lane = screen.getByTestId('technician-lane');
    expect(lane.className).toContain('technician-lane--drag-over');
  });

  it('sets data-technician-id attribute', () => {
    render(<TechnicianLane technician={technician} appointments={[]} />);
    const lane = screen.getByTestId('technician-lane');
    expect(lane).toHaveAttribute('data-technician-id', 'tech-1');
  });
});
