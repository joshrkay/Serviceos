import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router';
import { SchedulePage } from './SchedulePage';

vi.mock('../../hooks/useListQuery', () => ({ useListQuery: vi.fn() }));
vi.mock('../../data/mock-data', () => ({
  technicians: [
    { id: 't1', name: 'Carlos Reyes', initials: 'CR', color: '#3B82F6' },
    { id: 't2', name: 'Marcus Webb',  initials: 'MW', color: '#22C55E' },
    { id: 't3', name: 'Sarah Lin',    initials: 'SL', color: '#8B5CF6' },
  ],
}));

import { useListQuery } from '../../hooks/useListQuery';

const today = new Date().toISOString().split('T')[0];

const mockJobs = [
  {
    id: 'j1',
    jobNumber: 'JOB-001',
    summary: 'Fix AC unit not cooling',
    status: 'scheduled',
    serviceType: 'HVAC',
    scheduledStart: `${today}T09:00:00Z`,
    customer: { id: 'c1', displayName: 'Alice Smith' },
    technician: { id: 't1', firstName: 'Carlos', lastName: 'Reyes', color: '#3B82F6' },
  },
  {
    id: 'j2',
    jobNumber: 'JOB-002',
    summary: 'Drain cleaning',
    status: 'in_progress',
    serviceType: 'Plumbing',
    scheduledStart: `${today}T11:00:00Z`,
    customer: { id: 'c2', displayName: 'Bob Jones' },
    technician: { id: 't2', firstName: 'Marcus', lastName: 'Webb', color: '#22C55E' },
  },
];

const defaultListResult = {
  data: mockJobs,
  total: 2,
  page: 1,
  pageSize: 25,
  isLoading: false,
  error: null,
  refetch: vi.fn(),
  setPage: vi.fn(),
  setSearch: vi.fn(),
  setFilters: vi.fn(),
};

beforeEach(() => {
  vi.mocked(useListQuery).mockReturnValue(defaultListResult);
});

function renderPage() {
  return render(
    <MemoryRouter>
      <SchedulePage />
    </MemoryRouter>
  );
}

describe('SchedulePage', () => {
  it('renders jobs for selected date', () => {
    renderPage();
    expect(screen.getByText('Alice Smith')).toBeInTheDocument();
    expect(screen.getByText('Bob Jones')).toBeInTheDocument();
  });

  it('renders job summaries', () => {
    renderPage();
    expect(screen.getByText('Fix AC unit not cooling')).toBeInTheDocument();
    expect(screen.getByText('Drain cleaning')).toBeInTheDocument();
  });

  it('shows job count', () => {
    renderPage();
    expect(screen.getByText('2 jobs')).toBeInTheDocument();
  });

  it('renders technician names in jobs', () => {
    renderPage();
    // Tech names appear in the job cards (first name only)
    expect(screen.getAllByText('Carlos').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Marcus').length).toBeGreaterThan(0);
  });

  it('renders team today section', () => {
    renderPage();
    expect(screen.getByText('Team today')).toBeInTheDocument();
    expect(screen.getByText('Carlos Reyes')).toBeInTheDocument();
    expect(screen.getByText('Marcus Webb')).toBeInTheDocument();
    expect(screen.getByText('Sarah Lin')).toBeInTheDocument();
  });

  it('shows available for tech with no jobs', () => {
    renderPage();
    expect(screen.getByText('Available')).toBeInTheDocument();
  });

  it('shows loading spinner', () => {
    vi.mocked(useListQuery).mockReturnValue({ ...defaultListResult, isLoading: true, data: [] });
    const { container } = renderPage();
    expect(container.querySelector('.animate-spin')).toBeInTheDocument();
    expect(screen.queryByText('Alice Smith')).not.toBeInTheDocument();
  });

  it('shows error state with retry', () => {
    vi.mocked(useListQuery).mockReturnValue({ ...defaultListResult, error: 'HTTP 500', data: [] });
    renderPage();
    expect(screen.getByText('Failed to load schedule')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Retry'));
    expect(defaultListResult.refetch).toHaveBeenCalled();
  });

  it('shows empty state when no jobs', () => {
    vi.mocked(useListQuery).mockReturnValue({ ...defaultListResult, data: [] });
    renderPage();
    expect(screen.getByText('Nothing scheduled')).toBeInTheDocument();
  });

  it('calls setFilters with scheduledDate on initial render', () => {
    renderPage();
    expect(vi.mocked(useListQuery)).toHaveBeenCalledWith(
      '/api/jobs',
      expect.objectContaining({ filters: expect.objectContaining({ scheduledDate: expect.any(String) }) })
    );
  });

  it('date navigation prev button calls setFilters with new date', () => {
    renderPage();
    const prevButton = screen.getAllByRole('button').find(b => b.querySelector('svg'));
    // Click the chevron-left button (first nav button)
    const navButtons = screen.getAllByRole('button').filter(b =>
      b.className.includes('size-8')
    );
    fireEvent.click(navButtons[0]);
    expect(defaultListResult.setFilters).toHaveBeenCalledWith(
      expect.objectContaining({ scheduledDate: expect.any(String) })
    );
  });

  it('date navigation next button calls setFilters with new date', () => {
    renderPage();
    const navButtons = screen.getAllByRole('button').filter(b =>
      b.className.includes('size-8')
    );
    fireEvent.click(navButtons[1]);
    expect(defaultListResult.setFilters).toHaveBeenCalledWith(
      expect.objectContaining({ scheduledDate: expect.any(String) })
    );
  });

  it('tech filter button filters jobs by technician', () => {
    renderPage();
    // Click on Carlos filter button (first in tech filter bar — it's the first pill with 'Carlos')
    const carlosButtons = screen.getAllByRole('button', { name: /Carlos/i });
    fireEvent.click(carlosButtons[0]);
    // After filtering, only Carlos's job should show (Bob Jones hidden)
    expect(screen.queryByText('Bob Jones')).not.toBeInTheDocument();
    expect(screen.getAllByText('Alice Smith').length).toBeGreaterThan(0);
  });

  it('uses /api/jobs endpoint', () => {
    renderPage();
    expect(vi.mocked(useListQuery)).toHaveBeenCalledWith('/api/jobs', expect.any(Object));
  });
});
