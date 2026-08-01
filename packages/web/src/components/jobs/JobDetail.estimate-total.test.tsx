import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router';
import { JobDetailView } from './JobDetail';

// JobDetailView's own fetches (linked docs, notes, time entries) go through
// useApiClient; EstimateScopeCard fetches the estimate detail through the
// module-level api-fetch. Mock both so we can drive the estimate total.
const AH = vi.hoisted(() => ({ fetcher: vi.fn() }));
vi.mock('../../lib/apiClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/apiClient')>();
  return { ...actual, useApiClient: () => AH.fetcher };
});
vi.mock('../../utils/api-fetch', () => ({ apiFetch: vi.fn() }));

vi.mock('../../hooks/useDetailQuery', () => ({ useDetailQuery: vi.fn() }));
vi.mock('../../hooks/useMutation', () => ({ useMutation: vi.fn() }));
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
vi.mock('./JobProfitCard', () => ({ JobProfitCard: () => null }));

import { useDetailQuery } from '../../hooks/useDetailQuery';
import { useMutation } from '../../hooks/useMutation';
import { apiFetch } from '../../utils/api-fetch';

const mockApiJob = {
  id: 'j1',
  jobNumber: 'JOB-001',
  summary: 'Fix AC unit',
  status: 'scheduled',
  priority: 'normal',
  serviceType: 'HVAC',
  customer: {
    id: 'c1',
    displayName: 'Alice Smith',
    locations: [{ street1: '123 Main St', city: 'Austin', state: 'TX', postalCode: '78701' }],
  },
};

// EST-0002: line items sum to $353.00 pre-tax; with 8% tax the real total is
// $381.24 (totals.totalCents = 38124). The bug summed qty*rate ($353) and
// labelled it "Agreed total".
const estimateDetail = {
  id: 'est-1',
  estimateNumber: 'EST-0002',
  status: 'draft',
  lineItems: [
    { description: 'Diagnostic + repair', quantity: 1, unitPriceCents: 35300 },
  ],
  totals: {
    subtotalCents: 35300,
    taxableSubtotalCents: 35300,
    taxCents: 2824,
    totalCents: 38124,
  },
};

beforeEach(() => {
  vi.mocked(useDetailQuery).mockReturnValue({
    data: mockApiJob,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  } as never);
  vi.mocked(useMutation).mockReturnValue({ mutate: vi.fn(), isLoading: false, error: null } as never);

  // Linked-doc lookups (useApiClient): surface the estimate id for this job.
  AH.fetcher.mockImplementation((path: string) => {
    if (path.startsWith('/api/estimates?jobId=')) {
      return Promise.resolve({ ok: true, json: async () => [{ id: 'est-1' }] });
    }
    return Promise.resolve({ ok: true, json: async () => [] });
  });

  // Estimate detail (module api-fetch used by EstimateScopeCard).
  vi.mocked(apiFetch).mockImplementation(((input: RequestInfo | URL) => {
    if (String(input) === '/api/estimates/est-1') {
      return Promise.resolve({ ok: true, json: async () => estimateDetail } as unknown as Response);
    }
    return Promise.resolve({ ok: true, json: async () => [] } as unknown as Response);
  }) as typeof apiFetch);
});

describe('JobDetail estimate "Agreed total" (BUG B)', () => {
  it('shows the API tax-inclusive total, not the pre-tax line sum', async () => {
    render(
      <MemoryRouter>
        <JobDetailView id="j1" />
      </MemoryRouter>,
    );

    // The authoritative tax-inclusive total from totals.totalCents (rendered
    // in both the mobile and desktop layout columns).
    const totals = await screen.findAllByText('$381.24');
    expect(totals.length).toBeGreaterThan(0);

    // The pre-tax sum must NOT be presented as the agreed total.
    expect(screen.queryByText('$353.00')).not.toBeInTheDocument();
  });
});
