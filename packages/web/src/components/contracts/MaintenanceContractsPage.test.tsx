import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router';
import { MaintenanceContractsPage } from './MaintenanceContractsPage';

const mockNavigate = vi.fn();

vi.mock('react-router', async (importOriginal) => {
  const mod = await importOriginal<typeof import('react-router')>();
  return { ...mod, useNavigate: () => mockNavigate };
});

vi.mock('../../hooks/useListQuery', () => ({ useListQuery: vi.fn() }));
vi.mock('./CreateContractSheet', () => ({ CreateContractSheet: () => null }));

import { useListQuery } from '../../hooks/useListQuery';

const contracts = [
  {
    id: 'mc-1',
    name: 'HVAC Annual Plan',
    status: 'active',
    customer: { displayName: 'Alice Smith' },
    location: { street1: '123 Main St' },
    cadence: 'Monthly',
    serviceWindow: 'Mon-Fri 8-12',
  },
  {
    id: 'mc-2',
    name: 'Plumbing Bi-Weekly',
    status: 'paused',
    customer: { displayName: 'Bob Jones' },
    location: { street1: '456 Oak Ave' },
    cadence: 'Bi-weekly',
    serviceWindow: 'Tue-Thu 1-4',
  },
  {
    id: 'mc-3',
    name: 'Paint Care',
    status: 'cancelled',
    customer: { displayName: 'Charlie Ray' },
    location: { street1: '789 Pine Rd' },
    cadence: 'Quarterly',
    serviceWindow: 'Anytime',
  },
  {
    id: 'mc-4',
    name: 'Filter Club',
    customer: { displayName: 'Delta Home' },
    location: { street1: '100 Market St' },
    cadence: 'Monthly',
    serviceWindow: 'Anytime',
  },
];

const defaultListResult = {
  data: contracts,
  total: 4,
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
  vi.clearAllMocks();
  vi.mocked(useListQuery).mockReturnValue(defaultListResult);
});

function renderPage() {
  return render(
    <MemoryRouter>
      <MaintenanceContractsPage />
    </MemoryRouter>
  );
}

describe('MaintenanceContractsPage', () => {
  it('uses maintenance contracts endpoint', () => {
    renderPage();
    expect(vi.mocked(useListQuery)).toHaveBeenCalledWith('/api/agreements');
  });

  it('renders heading, stats, and contracts', () => {
    renderPage();
    expect(screen.getByText('Maintenance Contracts')).toBeInTheDocument();
    expect(screen.getAllByText('Active').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Paused').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Cancelled').length).toBeGreaterThan(0);
    expect(screen.getByText('HVAC Annual Plan')).toBeInTheDocument();
    expect(screen.getByText('Plumbing Bi-Weekly')).toBeInTheDocument();
    expect(screen.getByText('Paint Care')).toBeInTheDocument();
    expect(screen.getByText('Filter Club')).toBeInTheDocument();
    // Missing/unknown statuses should gracefully roll up into Active.
    expect(screen.getAllByText('Active').length).toBeGreaterThan(2);
  });

  it('shows + New Contract button', () => {
    renderPage();
    expect(screen.getByRole('button', { name: /\+ New Contract/i })).toBeInTheDocument();
  });

  it('navigates to contract detail route when card is clicked', () => {
    renderPage();
    fireEvent.click(screen.getByText('HVAC Annual Plan'));
    expect(mockNavigate).toHaveBeenCalledWith('/contracts/mc-1');
  });

  it('shows loading state', () => {
    vi.mocked(useListQuery).mockReturnValue({ ...defaultListResult, data: [], isLoading: true });
    renderPage();
    expect(screen.getByText('Loading contracts…')).toBeInTheDocument();
  });

  it('shows error state and retries', () => {
    vi.mocked(useListQuery).mockReturnValue({ ...defaultListResult, data: [], error: 'HTTP 500' });
    renderPage();
    expect(screen.getByText('Failed to load contracts')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(defaultListResult.refetch).toHaveBeenCalled();
  });
});
