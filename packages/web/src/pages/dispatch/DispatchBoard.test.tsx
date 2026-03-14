import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DispatchBoard } from './DispatchBoard';

vi.mock('../../hooks/useDispatchBoard', () => ({
  useDispatchBoard: vi.fn(),
}));

import { useDispatchBoard } from '../../hooks/useDispatchBoard';

const mockBoardData = {
  date: '2026-03-14',
  unassignedAppointments: [
    {
      id: 'unassigned-1',
      jobId: 'job-1',
      customerName: 'Jane Doe',
      locationAddress: '123 Main St',
      jobSummary: 'HVAC Repair',
      scheduledStart: '2026-03-14T09:00:00Z',
      scheduledEnd: '2026-03-14T11:00:00Z',
      status: 'scheduled',
    },
  ],
  technicianLanes: [
    {
      technicianId: 'tech-1',
      technicianName: 'John Smith',
      appointments: [
        {
          id: 'assigned-1',
          jobId: 'job-2',
          customerName: 'Bob Wilson',
          locationAddress: '456 Oak Ave',
          jobSummary: 'Plumbing Fix',
          technicianName: 'John Smith',
          scheduledStart: '2026-03-14T10:00:00Z',
          scheduledEnd: '2026-03-14T12:00:00Z',
          status: 'confirmed',
        },
      ],
    },
  ],
  summary: {
    unassigned: 1,
    scheduled: 1,
    inProgress: 0,
    completed: 0,
    canceled: 0,
  },
};

describe('P6-001 — Dispatch board day-view container', () => {
  beforeEach(() => {
    vi.mocked(useDispatchBoard).mockReturnValue({
      data: mockBoardData,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });
  });

  it('renders the dispatch board', () => {
    render(<DispatchBoard />);
    expect(screen.getByTestId('dispatch-board')).toBeInTheDocument();
    expect(screen.getByText('Dispatch Board')).toBeInTheDocument();
  });

  it('renders date navigation', () => {
    render(<DispatchBoard />);
    expect(screen.getByTestId('date-navigation')).toBeInTheDocument();
  });

  it('renders summary strip', () => {
    render(<DispatchBoard />);
    expect(screen.getByTestId('summary-strip')).toBeInTheDocument();
  });

  it('renders unassigned queue', () => {
    render(<DispatchBoard />);
    expect(screen.getByTestId('unassigned-queue')).toBeInTheDocument();
  });

  it('renders technician lanes', () => {
    render(<DispatchBoard />);
    expect(screen.getByTestId('dispatch-board-lanes')).toBeInTheDocument();
    expect(screen.getAllByText('John Smith').length).toBeGreaterThan(0);
  });

  it('shows loading state', () => {
    vi.mocked(useDispatchBoard).mockReturnValue({
      data: null,
      isLoading: true,
      error: null,
      refetch: vi.fn(),
    });
    render(<DispatchBoard />);
    expect(screen.getByTestId('dispatch-board-loading')).toBeInTheDocument();
  });

  it('shows error state with retry', () => {
    vi.mocked(useDispatchBoard).mockReturnValue({
      data: null,
      isLoading: false,
      error: 'Network error',
      refetch: vi.fn(),
    });
    render(<DispatchBoard />);
    expect(screen.getByTestId('dispatch-board-error')).toBeInTheDocument();
    expect(screen.getByText('Network error')).toBeInTheDocument();
    expect(screen.getByText('Retry')).toBeInTheDocument();
  });

  it('shows empty state when no technician lanes', () => {
    vi.mocked(useDispatchBoard).mockReturnValue({
      data: { ...mockBoardData, technicianLanes: [] },
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });
    render(<DispatchBoard />);
    expect(screen.getByTestId('dispatch-board-empty')).toBeInTheDocument();
  });
});
