/**
 * #1406 D3 — the Parts sheet persists: JobDetail loads the job's parts from
 * GET /api/jobs/:id/materials and saves the sheet with PUT (integer cents).
 * Seam: JobDetailView with the API client mocked.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router';
import { JobDetailView } from './JobDetail';

const AH = vi.hoisted(() => ({
  fetcher: vi.fn(),
  sheetResult: [] as Array<Record<string, unknown>>,
}));
vi.mock('../../lib/apiClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/apiClient')>();
  return { ...actual, useApiClient: () => AH.fetcher };
});

vi.mock('../../hooks/useDetailQuery', () => ({ useDetailQuery: vi.fn() }));
vi.mock('../../hooks/useMutation', () => ({ useMutation: vi.fn() }));
vi.mock('./ActivityTimeline', () => ({ ActivityTimeline: () => null }));
vi.mock('./AddEntrySheet', () => ({ AddEntrySheet: () => null }));
vi.mock('./MaterialsSheet', () => ({
  MaterialsSheet: ({ onClose }: { onClose: (items: unknown[]) => void }) => (
    <button data-testid="mock-save-materials" onClick={() => onClose(AH.sheetResult)}>
      save
    </button>
  ),
}));
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
    communicationNotes: 'Prefers afternoon appointments. Gate code is 1234. Dog in backyard.',
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

const noPhotos = vi.fn().mockResolvedValue([]);

function renderPage() {
  return render(
    <MemoryRouter>
      <JobDetailView id="j1" fetchPhotos={noPhotos as never} />
    </MemoryRouter>,
  );
}

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

beforeEach(() => {
  vi.mocked(useDetailQuery).mockReturnValue(defaultDetailResult);
  vi.mocked(useMutation).mockReturnValue({ mutate: vi.fn(), isLoading: false, error: null });
  AH.fetcher.mockReset();
  AH.sheetResult = [];
});

describe('JobDetailView — persisted parts (#1406 D3)', () => {
  it('shows the parts already saved on the job', async () => {
    AH.fetcher.mockImplementation(async (url: string) =>
      url === '/api/jobs/j1/materials'
        ? jsonResponse({
            data: [
              { id: 'm1', name: 'Contactor 40A 24V Coil', partNumber: 'CONT-2P-40A', quantity: 2, unitCostCents: 2200, category: 'Part', status: 'pending' },
            ],
          })
        : jsonResponse([]),
    );

    renderPage();

    await waitFor(() =>
      expect(screen.getAllByText('Contactor 40A 24V Coil').length).toBeGreaterThan(0),
    );
  });

  it('saving the sheet PUTs the list to the API in integer cents', async () => {
    AH.fetcher.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/jobs/j1/materials' && init?.method === 'PUT') {
        return jsonResponse({
          data: [{ id: 'm9', name: 'Nest Learning Thermostat', partNumber: 'NEST-GEN4', quantity: 1, unitCostCents: 19900, category: 'Equipment', status: 'pending' }],
        });
      }
      return url === '/api/jobs/j1/materials' ? jsonResponse({ data: [] }) : jsonResponse([]);
    });
    AH.sheetResult = [
      { id: 'm-1727400000000', name: 'Nest Learning Thermostat', partNumber: 'NEST-GEN4', qty: 1, unitCost: 199, category: 'Equipment' },
    ];

    renderPage();
    fireEvent.click(screen.getAllByText('Parts')[0]);
    fireEvent.click(screen.getByTestId('mock-save-materials'));

    await waitFor(() => {
      const put = AH.fetcher.mock.calls.find(
        ([url, init]) => url === '/api/jobs/j1/materials' && init?.method === 'PUT',
      );
      expect(put).toBeDefined();
      expect(JSON.parse(put![1].body as string)).toEqual({
        items: [
          { id: 'm-1727400000000', name: 'Nest Learning Thermostat', partNumber: 'NEST-GEN4', quantity: 1, unitCostCents: 19900, category: 'Equipment' },
        ],
      });
    });
  });
});
