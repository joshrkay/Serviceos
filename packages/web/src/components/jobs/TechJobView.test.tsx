import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router';

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

import { TechJobView } from './TechJobView';

const mockJob = {
  id: 'j1',
  jobNumber: '1001',
  summary: 'Fix HVAC',
  status: 'scheduled',
};

describe('TechJobView delay acknowledgement prompt', () => {
  beforeEach(() => {
    mockFetcher.mockReset();
    // /api/jobs/j1 → job detail; /api/notes → empty list
    mockFetcher.mockImplementation((path: string) => {
      if (path.startsWith('/api/jobs/')) {
        return Promise.resolve(new Response(JSON.stringify(mockJob), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
    });
  });

  it('renders fixed delay options and toggles with Yes/No', async () => {
    render(
      <MemoryRouter>
        <TechJobView id="j1" />
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.getByText('Running behind?')).toBeInTheDocument());

    const yesButton = screen.getByRole('button', { name: 'Yes' });
    const noButton = screen.getByRole('button', { name: 'No' });

    const chip10 = screen.getByRole('button', { name: '10' });
    const chip15 = screen.getByRole('button', { name: '15' });
    const chip20 = screen.getByRole('button', { name: '20' });
    const chip60 = screen.getByRole('button', { name: '60' });

    expect(chip10).toBeDisabled();
    expect(chip15).toBeDisabled();
    expect(chip20).toBeDisabled();
    expect(chip60).toBeDisabled();

    fireEvent.click(yesButton);

    expect(chip10).toBeEnabled();
    expect(chip15).toBeEnabled();
    expect(chip20).toBeEnabled();
    expect(chip60).toBeEnabled();

    fireEvent.click(chip20);
    // Path A (U10c): the selected chip is the brand primary, not raw indigo.
    expect(chip20).toHaveClass('bg-primary');

    fireEvent.click(noButton);
    expect(chip10).toBeDisabled();
    expect(chip15).toBeDisabled();
    expect(chip20).toBeDisabled();
    expect(chip60).toBeDisabled();
    expect(chip20).not.toHaveClass('bg-primary');
  });

  it('deletes a photo behind a confirm: calls deletePhoto and removes it from the gallery', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const photo = {
      id: 'p-del',
      tenantId: 't1',
      jobId: 'j1',
      uploadedByUserId: 'u1',
      fileId: 'f-del',
      category: 'before' as const,
      createdAt: '2026-06-27T10:00:00.000Z',
      downloadUrl: 'https://cdn.example/p-del.jpg',
      filename: 'p-del.jpg',
      contentType: 'image/jpeg',
      sizeBytes: 10,
    };
    const deletePhoto = vi.fn().mockResolvedValue(undefined);
    const fetchPhotos = vi.fn().mockResolvedValue([photo]);

    render(
      <MemoryRouter>
        <TechJobView
          id="j1"
          fetchPhotos={fetchPhotos as never}
          deletePhoto={deletePhoto as never}
        />
      </MemoryRouter>,
    );

    await waitFor(() =>
      expect(screen.getByTestId('job-photo-card-p-del')).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByTestId('job-photo-delete-p-del'));

    await waitFor(() => expect(deletePhoto).toHaveBeenCalledWith('j1', 'p-del'));
    await waitFor(() =>
      expect(screen.queryByTestId('job-photo-card-p-del')).not.toBeInTheDocument(),
    );
    confirmSpy.mockRestore();
  });

  it('surfaces a delete error and keeps the photo (no phantom removal)', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const photo = {
      id: 'p-err',
      tenantId: 't1',
      jobId: 'j1',
      uploadedByUserId: 'u1',
      fileId: 'f-err',
      category: 'before' as const,
      createdAt: '2026-06-27T10:00:00.000Z',
      downloadUrl: 'https://cdn.example/p-err.jpg',
      filename: 'p-err.jpg',
      contentType: 'image/jpeg',
      sizeBytes: 10,
    };
    const deletePhoto = vi.fn().mockRejectedValue(new Error('Delete failed: 403'));
    const fetchPhotos = vi.fn().mockResolvedValue([photo]);

    render(
      <MemoryRouter>
        <TechJobView
          id="j1"
          fetchPhotos={fetchPhotos as never}
          deletePhoto={deletePhoto as never}
        />
      </MemoryRouter>,
    );

    await waitFor(() =>
      expect(screen.getByTestId('job-photo-card-p-err')).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByTestId('job-photo-delete-p-err'));

    await waitFor(() =>
      expect(screen.getByTestId('tech-photo-error')).toHaveTextContent('Delete failed: 403'),
    );
    expect(screen.getByTestId('job-photo-card-p-err')).toBeInTheDocument();
    confirmSpy.mockRestore();
  });

  // U10c — Path A class contract: the tech view renders on brand tokens only.
  it('renders on Path A tokens — no raw Tailwind palette leaks', async () => {
    const { container } = render(
      <MemoryRouter>
        <TechJobView id="j1" />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText('Running behind?')).toBeInTheDocument());
    expect(container.innerHTML).not.toMatch(
      /(bg|text|border|border-l|placeholder|ring|divide|shadow|from|to|via)-(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}/,
    );
  });
});
