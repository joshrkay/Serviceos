/**
 * #1122 — technician photo surface.
 *
 * Scope decision (2026-09-26, owner-approved): link TechJobView to the
 * existing `/jobs/:id/photos` page (category select + pairing), and default
 * the camera category by job status (not started -> 'before'; in
 * progress/done -> 'after') instead of hardcoding 'before'
 * (`handleCameraClose`, TechJobView.tsx).
 *
 * CameraCapture is stubbed to a single button that immediately invokes
 * `onClose` with one photo capture, so these tests exercise
 * `handleCameraClose`'s category logic without the real camera UI.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router';
import type { CapturedMedia } from '../shared/CameraCapture';

const mockFetcher = vi.fn();

vi.mock('../../lib/apiClient', () => ({
  useApiClient: () => mockFetcher,
}));

vi.mock('@clerk/clerk-react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@clerk/clerk-react')>();
  return {
    ...actual,
    useAuth: () => ({
      isLoaded: true,
      isSignedIn: true,
      getToken: async () => 'tok',
    }),
  };
});

vi.mock('../shared/CameraCapture', () => ({
  CameraCapture: ({ onClose }: { onClose: (media: CapturedMedia[]) => void }) => (
    <button
      onClick={() =>
        onClose([
          { id: 'm1', type: 'photo', url: 'data:image/jpeg;base64,abc', capturedAt: '2026-01-01T00:00:00.000Z' },
        ])
      }
    >
      mock-capture-close
    </button>
  ),
}));

import { TechJobView } from './TechJobView';

function mockJob(status: string) {
  return { id: 'j1', jobNumber: '1001', summary: 'Fix HVAC', status };
}

function renderWithJob(status: string, uploadPhoto: ReturnType<typeof vi.fn>) {
  mockFetcher.mockImplementation((path: unknown) => {
    // Defensive: some unrelated async cleanup can invoke this mock after
    // the test's assertions run (e.g. React flushing a queued update
    // during unmount); only route real string paths.
    if (typeof path === 'string' && path.startsWith('/api/jobs/')) {
      return Promise.resolve(new Response(JSON.stringify(mockJob(status)), { status: 200 }));
    }
    return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
  });
  return render(
    <MemoryRouter>
      <TechJobView
        id="j1"
        uploadPhoto={uploadPhoto as never}
        fetchPhotos={vi.fn().mockResolvedValue([]) as never}
        deletePhoto={vi.fn() as never}
      />
    </MemoryRouter>,
  );
}

describe('#1122 — TechJobView links to the full photo gallery page', () => {
  beforeEach(() => mockFetcher.mockReset());

  it('renders a link to /jobs/:id/photos (category select + pairing)', async () => {
    renderWithJob('scheduled', vi.fn());
    await waitFor(() => expect(screen.getByText('Fix HVAC')).toBeInTheDocument());

    const link = screen.getByRole('link', { name: /full photo gallery/i });
    expect(link).toHaveAttribute('href', '/jobs/j1/photos');
  });

  it('the gallery link meets the >=44px glove tap target (min-h-11)', async () => {
    renderWithJob('scheduled', vi.fn());
    await waitFor(() => expect(screen.getByText('Fix HVAC')).toBeInTheDocument());
    const link = screen.getByRole('link', { name: /full photo gallery/i });
    expect(link.className).toContain('min-h-11');
  });
});

describe('#1122 — camera category defaults by job status (not hardcoded "before")', () => {
  beforeEach(() => mockFetcher.mockReset());

  it("defaults to 'before' when the job has not started (status: scheduled)", async () => {
    const uploadPhoto = vi.fn().mockResolvedValue({});
    renderWithJob('scheduled', uploadPhoto);
    await waitFor(() => expect(screen.getByText('Fix HVAC')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Photo'));
    fireEvent.click(await screen.findByText('mock-capture-close'));

    await waitFor(() => expect(uploadPhoto).toHaveBeenCalled());
    const [, , category] = uploadPhoto.mock.calls[0];
    expect(category).toBe('before');
  });

  it("defaults to 'after' when the job is in progress", async () => {
    const uploadPhoto = vi.fn().mockResolvedValue({});
    renderWithJob('in_progress', uploadPhoto);
    await waitFor(() => expect(screen.getByText('Fix HVAC')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Photo'));
    fireEvent.click(await screen.findByText('mock-capture-close'));

    await waitFor(() => expect(uploadPhoto).toHaveBeenCalled());
    const [, , category] = uploadPhoto.mock.calls[0];
    expect(category).toBe('after');
  });

  it("defaults to 'after' when the job is done (status: completed)", async () => {
    const uploadPhoto = vi.fn().mockResolvedValue({});
    renderWithJob('completed', uploadPhoto);
    await waitFor(() => expect(screen.getByText('Fix HVAC')).toBeInTheDocument());

    // 'completed' jobs render no bottom CTA / quick-action row (isComplete),
    // so open the camera via the Photos section's "Add photo" button instead.
    fireEvent.click(screen.getByText('Add photo'));
    fireEvent.click(await screen.findByText('mock-capture-close'));

    await waitFor(() => expect(uploadPhoto).toHaveBeenCalled());
    const [, , category] = uploadPhoto.mock.calls[0];
    expect(category).toBe('after');
  });
});
