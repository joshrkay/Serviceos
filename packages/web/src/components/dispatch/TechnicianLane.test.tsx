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

  describe('P6-020 — within-lane reorder UI', () => {
    it('does not render reorder controls when onReorderWithinLane is not supplied', () => {
      render(<TechnicianLane technician={technician} appointments={appointments} />);
      expect(screen.queryByTestId('lane-reorder-controls')).toBeNull();
    });

    it('renders reorder controls on every card when callback is supplied', () => {
      render(
        <TechnicianLane
          technician={technician}
          appointments={appointments}
          onReorderWithinLane={vi.fn()}
        />
      );
      const groups = screen.getAllByTestId('lane-reorder-controls');
      expect(groups).toHaveLength(2);
    });

    it('disables move-up on the first card and move-down on the last card', () => {
      render(
        <TechnicianLane
          technician={technician}
          appointments={appointments}
          onReorderWithinLane={vi.fn()}
        />
      );
      const ups = screen.getAllByTestId('lane-reorder-up');
      const downs = screen.getAllByTestId('lane-reorder-down');
      // sorted order: appt-1 (09:00) first, appt-2 (14:00) last
      expect(ups[0]).toBeDisabled();
      expect(ups[1]).not.toBeDisabled();
      expect(downs[0]).not.toBeDisabled();
      expect(downs[1]).toBeDisabled();
    });

    it('fires onReorderWithinLane with appointment id and target index', () => {
      const onReorder = vi.fn();
      render(
        <TechnicianLane
          technician={technician}
          appointments={appointments}
          onReorderWithinLane={onReorder}
        />
      );
      // Move the second card (appt-2) up → from index 1 to 0.
      const ups = screen.getAllByTestId('lane-reorder-up');
      ups[1].click();
      expect(onReorder).toHaveBeenCalledWith('appt-2', 1, 0);

      // Move the first card (appt-1) down → from 0 to 1.
      const downs = screen.getAllByTestId('lane-reorder-down');
      downs[0].click();
      expect(onReorder).toHaveBeenCalledWith('appt-1', 0, 1);
    });
  });
});
