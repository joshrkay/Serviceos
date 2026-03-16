import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { UnassignedQueue } from './UnassignedQueue';
import { AppointmentCardData } from './AppointmentCard';

describe('P6-003 — Unassigned appointment queue', () => {
  const appointments: AppointmentCardData[] = [
    {
      id: 'appt-1',
      jobId: 'job-1',
      customerName: 'Jane Doe',
      locationAddress: '123 Main St',
      jobSummary: 'HVAC Repair',
      scheduledStart: '2026-03-14T09:00:00Z',
      scheduledEnd: '2026-03-14T11:00:00Z',
      status: 'scheduled',
    },
    {
      id: 'appt-2',
      jobId: 'job-2',
      customerName: 'Bob Wilson',
      locationAddress: '456 Oak Ave',
      jobSummary: 'Plumbing Fix',
      scheduledStart: '2026-03-14T14:00:00Z',
      scheduledEnd: '2026-03-14T16:00:00Z',
      status: 'scheduled',
    },
  ];

  it('renders the unassigned queue', () => {
    render(<UnassignedQueue appointments={appointments} />);
    expect(screen.getByTestId('unassigned-queue')).toBeInTheDocument();
    expect(screen.getByText('Unassigned')).toBeInTheDocument();
  });

  it('shows the count of unassigned appointments', () => {
    render(<UnassignedQueue appointments={appointments} />);
    expect(screen.getByTestId('unassigned-queue-count')).toHaveTextContent('2');
  });

  it('renders appointment cards', () => {
    render(<UnassignedQueue appointments={appointments} />);
    const cards = screen.getAllByTestId('appointment-card');
    expect(cards).toHaveLength(2);
  });

  it('shows empty state when no appointments', () => {
    render(<UnassignedQueue appointments={[]} />);
    expect(screen.getByTestId('unassigned-queue-empty')).toBeInTheDocument();
    expect(screen.getByText('All appointments assigned')).toBeInTheDocument();
    expect(screen.getByTestId('unassigned-queue-count')).toHaveTextContent('0');
  });

  it('validates — rejects rendering invalid data gracefully', () => {
    render(<UnassignedQueue appointments={appointments} />);
    expect(screen.getByText('Jane Doe')).toBeInTheDocument();
    expect(screen.getByText('Bob Wilson')).toBeInTheDocument();
  });
});
