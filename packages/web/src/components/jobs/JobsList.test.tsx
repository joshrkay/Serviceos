import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router';
import { JobsList } from './JobsList';

vi.mock('../../hooks/useListQuery', () => ({ useListQuery: vi.fn() }));
vi.mock('./NewJobFlow', () => ({ NewJobFlow: () => null }));

import { useListQuery } from '../../hooks/useListQuery';

const mockJobs = [
  {
    id: 'j1',
    jobNumber: 'JOB-001',
    summary: 'Fix AC unit',
    status: 'scheduled',
    priority: 'normal',
    serviceType: 'HVAC',
    scheduledStart: '2026-03-15T09:00:00Z',
    customer: { id: 'c1', displayName: 'Alice Smith', firstName: 'Alice', lastName: 'Smith' },
    technician: { id: 't1', firstName: 'Carlos', lastName: 'Reyes', color: '#3B82F6' },
  },
  {
    id: 'j2',
    jobNumber: 'JOB-002',
    summary: 'Drain cleaning',
    status: 'in_progress',
    priority: 'urgent',
    serviceType: 'Plumbing',
    customer: { id: 'c2', displayName: 'Bob Jones', firstName: 'Bob', lastName: 'Jones' },
  },
  {
    id: 'j3',
    jobNumber: 'JOB-003',
    summary: 'Thermostat install',
    status: 'completed',
    priority: 'normal',
    serviceType: 'HVAC',
    customer: { id: 'c3', displayName: 'Carol White' },
  },
];

const defaultListResult = {
  data: mockJobs,
  total: 3,
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
      <JobsList />
    </MemoryRouter>
  );
}

describe('JobsList', () => {
  it('renders job list with customer names', () => {
    renderPage();
    expect(screen.getByText('Alice Smith')).toBeInTheDocument();
    expect(screen.getByText('Bob Jones')).toBeInTheDocument();
    expect(screen.getByText('Carol White')).toBeInTheDocument();
  });

  it('renders job numbers', () => {
    renderPage();
    expect(screen.getByText('#JOB-001')).toBeInTheDocument();
    expect(screen.getByText('#JOB-002')).toBeInTheDocument();
  });

  it('renders job summaries', () => {
    renderPage();
    expect(screen.getByText('Fix AC unit')).toBeInTheDocument();
    expect(screen.getByText('Drain cleaning')).toBeInTheDocument();
  });

  it('normalizes API statuses to UI labels', () => {
    renderPage();
    expect(screen.getAllByText('Scheduled').length).toBeGreaterThan(0);
    expect(screen.getAllByText('In Progress').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Completed').length).toBeGreaterThan(0);
  });

  it('shows stats bar', () => {
    renderPage();
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getAllByText('Scheduled').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Completed').length).toBeGreaterThan(0);
  });

  it('calls setSearch when user types in search', () => {
    renderPage();
    const input = screen.getByPlaceholderText('Search by customer, description, or job #…');
    fireEvent.change(input, { target: { value: 'alice' } });
    expect(defaultListResult.setSearch).toHaveBeenCalledWith('alice');
  });

  it('tab filter calls setFilters with API status', () => {
    renderPage();
    fireEvent.click(screen.getAllByRole('button', { name: /In Progress/ })[0]);
    expect(defaultListResult.setFilters).toHaveBeenCalledWith({ status: 'in_progress' });
  });

  it('All tab clears filters', () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /^All/ }));
    expect(defaultListResult.setFilters).toHaveBeenCalledWith({});
  });

  it('shows loading state', () => {
    vi.mocked(useListQuery).mockReturnValue({ ...defaultListResult, isLoading: true, data: [] });
    renderPage();
    expect(screen.queryByText('Alice Smith')).not.toBeInTheDocument();
  });

  it('shows error state with retry', () => {
    vi.mocked(useListQuery).mockReturnValue({ ...defaultListResult, error: 'HTTP 500', data: [] });
    renderPage();
    expect(screen.getByText('Failed to load jobs')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Retry'));
    expect(defaultListResult.refetch).toHaveBeenCalled();
  });

  it('shows empty state when no jobs match filter', () => {
    vi.mocked(useListQuery).mockReturnValue({ ...defaultListResult, data: [], total: 0 });
    renderPage();
    expect(screen.getByText('No jobs match your filter')).toBeInTheDocument();
  });

  it('uses /api/jobs endpoint', () => {
    renderPage();
    expect(vi.mocked(useListQuery)).toHaveBeenCalledWith('/api/jobs');
  });
});
