import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router';
import { JobDetailView } from './JobDetail';

// Controllable API client so the jobId-filtered estimate/invoice/appointment
// fetches can be driven per test. Defaults to empty arrays for every path.
const AH = vi.hoisted(() => ({ fetcher: vi.fn() }));
vi.mock('../../lib/apiClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/apiClient')>();
  return { ...actual, useApiClient: () => AH.fetcher };
});

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
  EstimateSheet: ({ jobId }: { jobId: string }) => <div data-testid="estimate-sheet" data-job-id={jobId} />,
  InvoiceSheet: ({ jobId }: { jobId: string }) => <div data-testid="invoice-sheet" data-job-id={jobId} />,
}));
// U9 (E7): a controllable CameraCapture mock. The button fires onClose with a
// preset captured-photo set so we can drive the persist pipeline in jsdom.
const CAPTURED = [
  {
    id: 'cap-1',
    type: 'photo' as const,
    url: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==',
    capturedAt: '2026-06-27T10:00:00.000Z',
  },
];
vi.mock('../shared/CameraCapture', () => ({
  CameraCapture: ({ onClose }: { onClose: (m: typeof CAPTURED) => void }) => (
    <button data-testid="mock-finish-capture" onClick={() => onClose(CAPTURED)}>
      finish
    </button>
  ),
}));
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

beforeEach(() => {
  vi.mocked(useDetailQuery).mockReturnValue(defaultDetailResult);
  vi.mocked(useMutation).mockReturnValue({ mutate: vi.fn(), isLoading: false, error: null });
  AH.fetcher.mockReset();
  AH.fetcher.mockResolvedValue({ ok: true, json: async () => [] });
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

  it('surfaces customer notes on the job page', () => {
    renderPage();
    expect(screen.getAllByText('Prefers afternoon appointments. Gate code is 1234. Dog in backyard.').length).toBeGreaterThan(0);
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

  // U9 (E7) — captured photos persist to the backend and render from the server.
  describe('photo persistence', () => {
    function makePhoto(id: string, category: 'before' | 'after' = 'before') {
      return {
        id,
        tenantId: 't1',
        jobId: 'j1',
        uploadedByUserId: 'u1',
        fileId: `f-${id}`,
        category,
        createdAt: '2026-06-27T10:00:00.000Z',
        downloadUrl: `https://cdn.example/${id}.jpg`,
        filename: `${id}.jpg`,
        contentType: 'image/jpeg',
        sizeBytes: 10,
      };
    }

    function renderWithPhotos(opts: {
      uploadPhoto: ReturnType<typeof vi.fn>;
      fetchPhotos: ReturnType<typeof vi.fn>;
      deletePhoto?: ReturnType<typeof vi.fn>;
    }) {
      return render(
        <MemoryRouter>
          <JobDetailView
            id="j1"
            uploadPhoto={opts.uploadPhoto as never}
            fetchPhotos={opts.fetchPhotos as never}
            deletePhoto={opts.deletePhoto as never}
          />
        </MemoryRouter>,
      );
    }

    it('uploads each captured photo via uploadJobPhoto with jobId + category, then shows it in the gallery', async () => {
      const uploaded = makePhoto('p-new');
      const uploadPhoto = vi.fn().mockResolvedValue(uploaded);
      // First load: empty. After upload: the persisted photo.
      const fetchPhotos = vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValue([uploaded]);

      renderWithPhotos({ uploadPhoto, fetchPhotos });

      fireEvent.click(screen.getAllByTestId('site-media-add')[0]);
      fireEvent.click(screen.getAllByTestId('mock-finish-capture')[0]);

      await waitFor(() => expect(uploadPhoto).toHaveBeenCalledTimes(1));
      expect(uploadPhoto).toHaveBeenCalledWith(
        'j1',
        expect.any(File),
        'before',
        undefined,
        '2026-06-27T10:00:00.000Z',
      );

      // Persisted photo is rendered from the server-backed gallery.
      await waitFor(() =>
        expect(screen.getAllByTestId('job-photo-card-p-new').length).toBeGreaterThan(0),
      );
    });

    it('surfaces an upload error and does not show a phantom persisted photo', async () => {
      const uploadPhoto = vi.fn().mockRejectedValue(new Error('S3 PUT failed: 500'));
      const fetchPhotos = vi.fn().mockResolvedValue([]); // server still has nothing

      renderWithPhotos({ uploadPhoto, fetchPhotos });

      fireEvent.click(screen.getAllByTestId('site-media-add')[0]);
      fireEvent.click(screen.getAllByTestId('mock-finish-capture')[0]);

      await waitFor(() =>
        expect(screen.getAllByTestId('job-photo-error')[0]).toHaveTextContent('S3 PUT failed: 500'),
      );
      // No photo card appears — the failed capture was not faked into the gallery.
      expect(screen.queryByTestId('job-photo-card-p-new')).not.toBeInTheDocument();
      expect(screen.getAllByTestId('job-photo-empty').length).toBeGreaterThan(0);
    });

    it('renders photos already persisted on load', async () => {
      const existing = makePhoto('p-existing');
      const uploadPhoto = vi.fn();
      const fetchPhotos = vi.fn().mockResolvedValue([existing]);

      renderWithPhotos({ uploadPhoto, fetchPhotos });

      await waitFor(() =>
        expect(screen.getAllByTestId('job-photo-card-p-existing').length).toBeGreaterThan(0),
      );
      expect(uploadPhoto).not.toHaveBeenCalled();
    });

    it('deletes a photo behind a confirm: calls deleteJobPhoto and removes it from the gallery', async () => {
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
      const uploadPhoto = vi.fn();
      const deletePhoto = vi.fn().mockResolvedValue(undefined);
      const fetchPhotos = vi.fn().mockResolvedValue([makePhoto('p-del')]);

      renderWithPhotos({ uploadPhoto, fetchPhotos, deletePhoto });

      await waitFor(() =>
        expect(screen.getAllByTestId('job-photo-card-p-del').length).toBeGreaterThan(0),
      );

      fireEvent.click(screen.getAllByTestId('job-photo-delete-p-del')[0]);

      await waitFor(() => expect(deletePhoto).toHaveBeenCalledWith('j1', 'p-del'));
      await waitFor(() =>
        expect(screen.queryByTestId('job-photo-card-p-del')).not.toBeInTheDocument(),
      );
      confirmSpy.mockRestore();
    });

    it('does not delete when the confirm is dismissed', async () => {
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
      const uploadPhoto = vi.fn();
      const deletePhoto = vi.fn().mockResolvedValue(undefined);
      const fetchPhotos = vi.fn().mockResolvedValue([makePhoto('p-keep')]);

      renderWithPhotos({ uploadPhoto, fetchPhotos, deletePhoto });

      await waitFor(() =>
        expect(screen.getAllByTestId('job-photo-card-p-keep').length).toBeGreaterThan(0),
      );

      fireEvent.click(screen.getAllByTestId('job-photo-delete-p-keep')[0]);

      expect(deletePhoto).not.toHaveBeenCalled();
      expect(screen.getAllByTestId('job-photo-card-p-keep').length).toBeGreaterThan(0);
      confirmSpy.mockRestore();
    });

    it('surfaces a delete error and keeps the photo (no phantom removal)', async () => {
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
      const uploadPhoto = vi.fn();
      const deletePhoto = vi.fn().mockRejectedValue(new Error('Delete failed: 403'));
      const fetchPhotos = vi.fn().mockResolvedValue([makePhoto('p-err')]);

      renderWithPhotos({ uploadPhoto, fetchPhotos, deletePhoto });

      await waitFor(() =>
        expect(screen.getAllByTestId('job-photo-card-p-err').length).toBeGreaterThan(0),
      );

      fireEvent.click(screen.getAllByTestId('job-photo-delete-p-err')[0]);

      await waitFor(() =>
        expect(screen.getAllByTestId('job-photo-error')[0]).toHaveTextContent('Delete failed: 403'),
      );
      // The photo is still present — the failed delete did not remove it.
      expect(screen.getAllByTestId('job-photo-card-p-err').length).toBeGreaterThan(0);
      confirmSpy.mockRestore();
    });
  });

  describe('status transition control', () => {
    it('backward reschedule (in_progress → scheduled) sends a non-empty reason', async () => {
      const mutate = vi.fn().mockResolvedValue({});
      vi.mocked(useMutation).mockReturnValue({ mutate, isLoading: false, error: null });
      vi.mocked(useDetailQuery).mockReturnValue({
        ...defaultDetailResult,
        data: { ...mockApiJob, status: 'in_progress' },
      });
      renderPage();

      fireEvent.change(screen.getByTitle('Change job status'), { target: { value: 'scheduled' } });

      await waitFor(() =>
        expect(mutate).toHaveBeenCalledWith({
          status: 'scheduled',
          reason: expect.stringMatching(/\S/),
        }),
      );
    });

    it('shows the error affordance when a transition fails instead of swallowing it', async () => {
      const mutate = vi.fn().mockRejectedValue(new Error('HTTP 400'));
      vi.mocked(useMutation).mockReturnValue({ mutate, isLoading: false, error: null });
      vi.mocked(useDetailQuery).mockReturnValue({
        ...defaultDetailResult,
        data: { ...mockApiJob, status: 'in_progress' },
      });
      renderPage();

      fireEvent.change(screen.getByTitle('Change job status'), { target: { value: 'scheduled' } });

      await waitFor(() =>
        expect(screen.getByTestId('job-transition-error')).toHaveTextContent('HTTP 400'),
      );
    });
  });

  // U9 — the status stepper is derived from the real job.status.
  describe('status stepper', () => {
    it('renders a completed job with the stepper at Completed', () => {
      vi.mocked(useDetailQuery).mockReturnValue({
        ...defaultDetailResult,
        data: { ...mockApiJob, status: 'completed' },
      });
      renderPage();
      // LeftContent renders in both the desktop and mobile layouts.
      expect(screen.getAllByTestId('status-stepper')[0]).toHaveAttribute('data-current-step', 'Completed');
    });

    it('renders a scheduled job with the stepper at Scheduled', () => {
      renderPage();
      expect(screen.getAllByTestId('status-stepper')[0]).toHaveAttribute('data-current-step', 'Scheduled');
    });
  });

  // U9 — the invoice action is wired off the jobId-filtered invoices fetch.
  describe('invoice action', () => {
    it('opens the invoice sheet wired to the real job id for a job with a linked invoice', async () => {
      AH.fetcher.mockImplementation((url: string) => {
        if (url.startsWith('/api/invoices')) {
          return Promise.resolve({
            ok: true,
            json: async () => [{ id: 'inv-real', jobId: 'j1', invoiceNumber: 'INV-9' }],
          });
        }
        return Promise.resolve({ ok: true, json: async () => [] });
      });

      renderPage();

      // The invoice was fetched by the real job id.
      await waitFor(() =>
        expect(AH.fetcher).toHaveBeenCalledWith('/api/invoices?jobId=j1'),
      );

      const invoiceAction = screen.getByRole('button', { name: 'Invoice' });
      expect(invoiceAction).toBeEnabled();
      fireEvent.click(invoiceAction);

      const sheet = await screen.findByTestId('invoice-sheet');
      expect(sheet).toHaveAttribute('data-job-id', 'j1');
    });
  });

  // U10b — Path A class contract: the largest jobs file renders on brand tokens.
  it('renders on Path A tokens — no raw Tailwind palette leaks', () => {
    const { container } = renderPage();
    expect(container.innerHTML).not.toMatch(
      /(bg|text|border|border-l|placeholder|ring|divide)-(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}/,
    );
  });
});
