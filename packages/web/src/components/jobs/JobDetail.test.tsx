import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router';
import { JobDetailView } from './JobDetail';

vi.mock('../../hooks/useDetailQuery', () => ({ useDetailQuery: vi.fn() }));
vi.mock('../../hooks/useMutation', () => ({ useMutation: vi.fn() }));
vi.mock('../../data/mock-data', () => ({
  calcMaterialsTotal: vi.fn(() => 0),
  calcEstimateTotal: vi.fn(() => 0),
  estimates: [],
}));
vi.mock('./ActivityTimeline', () => ({ ActivityTimeline: () => null }));
vi.mock('./AddEntrySheet', () => ({ AddEntrySheet: () => null }));
vi.mock('./MaterialsSheet', () => ({ MaterialsSheet: () => null }));
vi.mock('./CancelNoShowSheet', () => ({ CancelNoShowSheet: () => null }));
vi.mock('./JobSheets', () => ({
  CallScreen: () => null,
  TextSheet: () => null,
  EstimateSheet: () => null,
  InvoiceSheet: () => null,
}));
vi.mock('../shared/CameraCapture', () => ({ CameraCapture: () => null }));
vi.mock('./SuppliersSheet', () => ({ SuppliersSheet: () => null }));

import { useDetailQuery } from '../../hooks/useDetailQuery';
import { useMutation } from '../../hooks/useMutation';

const mockApiJob = {
  id: 'j1',
  jobNumber: 'JOB-001',
  summary: 'Fix AC unit not cooling',
  problemDescription: 'Unit blows warm air',
  status: 'scheduled',
  priority: 'normal',
  serviceType: 'HVAC',
  scheduledStart: '2026-03-15T09:00:00Z',
  customer: {
    id: 'c1',
    displayName: 'Alice Smith',
    firstName: 'Alice',
    lastName: 'Smith',
    primaryPhone: '5125550001',
    email: 'alice@example.com',
    locations: [{ street1: '123 Main St', city: 'Austin', state: 'TX', postalCode: '78701' }],
  },
  technician: {
    id: 't1',
    firstName: 'Carlos',
    lastName: 'Reyes',
    color: '#3B82F6',
  },
};

const defaultDetailResult = {
  data: mockApiJob,
  isLoading: false,
  error: null,
  refetch: vi.fn(),
};

beforeEach(() => {
  vi.mocked(useDetailQuery).mockReturnValue(defaultDetailResult);
  vi.mocked(useMutation).mockReturnValue({ mutate: vi.fn(), isLoading: false, error: null });
});

function renderPage(id = 'j1') {
  return render(
    <MemoryRouter>
      <JobDetailView id={id} />
    </MemoryRouter>
  );
}

describe('JobDetailView', () => {
  it('renders customer name', () => {
    renderPage();
    expect(screen.getAllByText('Alice Smith').length).toBeGreaterThan(0);
  });

  it('renders job number', () => {
    renderPage();
    expect(screen.getByText(/JOB-001/)).toBeInTheDocument();
  });

  it('renders job summary', () => {
    renderPage();
    expect(screen.getAllByText('Fix AC unit not cooling').length).toBeGreaterThan(0);
  });

  it('renders normalized status', () => {
    renderPage();
    expect(screen.getAllByText('Scheduled').length).toBeGreaterThan(0);
  });

  it('renders technician name', () => {
    renderPage();
    expect(screen.getAllByText(/Carlos/).length).toBeGreaterThan(0);
  });

  it('shows loading spinner', () => {
    vi.mocked(useDetailQuery).mockReturnValue({ ...defaultDetailResult, isLoading: true, data: null });
    const { container } = renderPage();
    // Loading spinner present (no customer name)
    expect(screen.queryByText('Alice Smith')).not.toBeInTheDocument();
    expect(container.querySelector('.animate-spin')).toBeInTheDocument();
  });

  it('shows error state when API fails', () => {
    vi.mocked(useDetailQuery).mockReturnValue({ ...defaultDetailResult, error: 'HTTP 404', data: null });
    renderPage();
    expect(screen.getByText('Failed to load job.')).toBeInTheDocument();
  });

  it('shows not-found message when data is null', () => {
    vi.mocked(useDetailQuery).mockReturnValue({ ...defaultDetailResult, data: null });
    renderPage();
    expect(screen.getByText('Job not found.')).toBeInTheDocument();
  });

  it('uses /api/jobs endpoint with correct id', () => {
    renderPage('j1');
    expect(vi.mocked(useDetailQuery)).toHaveBeenCalledWith('/api/jobs', 'j1');
  });
});
