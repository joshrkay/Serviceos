import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { AppointmentCard, AppointmentCardData } from './AppointmentCard';

describe('P6-002 — Appointment card model', () => {
  const mockAppointment: AppointmentCardData = {
    id: 'appt-1',
    jobId: 'job-1',
    customerName: 'Jane Doe',
    locationAddress: '123 Main St, Springfield',
    jobSummary: 'HVAC Repair',
    technicianName: 'John Smith',
    scheduledStart: '2026-03-14T09:00:00Z',
    scheduledEnd: '2026-03-14T11:00:00Z',
    arrivalWindowStart: '2026-03-14T08:30:00Z',
    arrivalWindowEnd: '2026-03-14T09:30:00Z',
    status: 'scheduled',
    paymentIndicator: 'Paid',
  };

  it('renders appointment card with all fields', () => {
    render(<AppointmentCard appointment={mockAppointment} />);
    expect(screen.getByTestId('appointment-card')).toBeInTheDocument();
    expect(screen.getByTestId('appointment-customer')).toHaveTextContent('Jane Doe');
    expect(screen.getByTestId('appointment-location')).toHaveTextContent('123 Main St, Springfield');
    expect(screen.getByTestId('appointment-summary')).toHaveTextContent('HVAC Repair');
    expect(screen.getByTestId('appointment-technician')).toHaveTextContent('John Smith');
    expect(screen.getByTestId('appointment-status')).toHaveTextContent('scheduled');
    expect(screen.getByTestId('appointment-payment')).toHaveTextContent('Paid');
  });

  it('renders without optional fields', () => {
    const minimal: AppointmentCardData = {
      id: 'appt-2',
      jobId: 'job-2',
      customerName: 'Bob',
      locationAddress: '456 Oak Ave',
      jobSummary: 'Plumbing',
      scheduledStart: '2026-03-14T14:00:00Z',
      scheduledEnd: '2026-03-14T16:00:00Z',
      status: 'scheduled',
    };
    render(<AppointmentCard appointment={minimal} />);
    expect(screen.getByTestId('appointment-card')).toBeInTheDocument();
    expect(screen.queryByTestId('appointment-technician')).not.toBeInTheDocument();
    expect(screen.queryByTestId('appointment-arrival')).not.toBeInTheDocument();
    expect(screen.queryByTestId('appointment-payment')).not.toBeInTheDocument();
  });

  it('shows arrival window when provided', () => {
    render(<AppointmentCard appointment={mockAppointment} />);
    expect(screen.getByTestId('appointment-arrival')).toBeInTheDocument();
  });

  it('applies dragging class when isDragging', () => {
    render(<AppointmentCard appointment={mockAppointment} isDragging={true} />);
    const card = screen.getByTestId('appointment-card');
    expect(card.className).toContain('appointment-card--dragging');
  });

  it('sets draggable attribute when draggable prop is true', () => {
    render(<AppointmentCard appointment={mockAppointment} draggable={true} />);
    const card = screen.getByTestId('appointment-card');
    expect(card).toHaveAttribute('draggable', 'true');
  });

  it('displays status with correct formatting', () => {
    const inProgress = { ...mockAppointment, status: 'in_progress' };
    render(<AppointmentCard appointment={inProgress} />);
    expect(screen.getByTestId('appointment-status')).toHaveTextContent('in progress');
  });
});
