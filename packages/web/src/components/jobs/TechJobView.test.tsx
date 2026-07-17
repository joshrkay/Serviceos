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
import { TenantTimezoneProvider } from '../../hooks/useTenantTimezone';

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

describe('TechJobView status flow', () => {
  function mockRoutes({ jobStatus, transcript }: { jobStatus: string; transcript?: string }) {
    mockFetcher.mockImplementation((path: string) => {
      if (path.includes('/transition')) {
        return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
      }
      if (path.startsWith('/api/jobs/')) {
        return Promise.resolve(
          new Response(JSON.stringify({ ...mockJob, status: jobStatus }), { status: 200 }),
        );
      }
      if (path === '/api/voice/transcribe') {
        return Promise.resolve(new Response(JSON.stringify({ transcript }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
    });
  }

  function transitionCalls() {
    return mockFetcher.mock.calls.filter(([p]) => String(p).includes('/transition'));
  }

  function renderView() {
    return render(
      <MemoryRouter>
        <TechJobView id="j1" />
      </MemoryRouter>,
    );
  }

  beforeEach(() => {
    mockFetcher.mockReset();
  });

  it("at in_progress the primary CTA posts {status:'completed'} and reaches Complete", async () => {
    mockRoutes({ jobStatus: 'in_progress' });
    renderView();

    const [cta] = await screen.findAllByRole('button', { name: /Mark Complete/ });
    fireEvent.click(cta);

    await waitFor(() => expect(screen.getByText('Job complete!')).toBeInTheDocument());

    const calls = transitionCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('/api/jobs/j1/transition');
    expect(JSON.parse((calls[0][1] as RequestInit).body as string)).toEqual({ status: 'completed' });
  });

  it('surfaces a rejected transition and does not falsely advance', async () => {
    mockFetcher.mockImplementation((path: string) => {
      if (path.includes('/transition')) {
        return Promise.resolve(
          new Response(JSON.stringify({ message: 'Transition rejected' }), { status: 400 }),
        );
      }
      if (path.startsWith('/api/jobs/')) {
        return Promise.resolve(
          new Response(JSON.stringify({ ...mockJob, status: 'in_progress' }), { status: 200 }),
        );
      }
      return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
    });
    renderView();

    const [cta] = await screen.findAllByRole('button', { name: /Mark Complete/ });
    fireEvent.click(cta);

    await waitFor(() =>
      expect(screen.getByTestId('tech-status-error')).toHaveTextContent('Transition rejected'),
    );
    // Still at In Progress — the CTA did not advance to Complete.
    expect(screen.queryByText('Job complete!')).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Mark Complete/ }).length).toBeGreaterThan(0);
  });

  it("in 'waiting' the CTA resumes to In Progress without posting a transition", async () => {
    // 'waiting' is a branch entered only via an explicit status update — here
    // through the real voice path with stubbed media APIs.
    class FakeMediaRecorder {
      static isTypeSupported = () => true;
      state = 'recording';
      mimeType = 'audio/webm';
      stream = { getTracks: () => [] as Array<{ stop: () => void }> };
      ondataavailable: ((e: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      start() {}
      stop() { this.state = 'inactive'; this.onstop?.(); }
    }
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
    Object.defineProperty(window.navigator, 'mediaDevices', {
      value: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [] }) },
      configurable: true,
    });

    try {
      mockRoutes({ jobStatus: 'in_progress', transcript: 'waiting on parts' });
      renderView();

      fireEvent.click(await screen.findByText('Tap to add by voice'));
      fireEvent.click(await screen.findByRole('button', { name: /Done talking/ }));
      fireEvent.click(await screen.findByRole('button', { name: /Add all/ }));

      const [resume] = await screen.findAllByRole('button', { name: /Resume Job/ });
      // Entering the waiting branch posted no self-transition.
      expect(transitionCalls()).toHaveLength(0);

      fireEvent.click(resume);

      await waitFor(() =>
        expect(screen.getAllByRole('button', { name: /Mark Complete/ }).length).toBeGreaterThan(0),
      );
      // Resuming is local-only — still no transition posted.
      expect(transitionCalls()).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('renders persisted notes from the bare-array GET /api/notes response', async () => {
    mockFetcher.mockImplementation((path: string) => {
      if (path.startsWith('/api/notes')) {
        return Promise.resolve(
          new Response(
            JSON.stringify([
              { id: 'n1', content: 'Compressor squealing on start', createdAt: '2026-07-08T12:00:00Z' },
            ]),
            { status: 200 },
          ),
        );
      }
      if (path.startsWith('/api/jobs/')) {
        return Promise.resolve(new Response(JSON.stringify(mockJob), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
    });
    renderView();

    await waitFor(() =>
      expect(screen.getByText('Compressor squealing on start')).toBeInTheDocument(),
    );
  });
});

// Finding 4 (WS6) — the job hero's scheduled date/time was rendered with
// `new Date(iso).toLocaleDateString()/toLocaleTimeString()` (browser-local), so
// the same instant showed a different wall clock for every viewer. It must
// render in the TENANT tz, deterministically, regardless of the JS runtime tz.
describe('TechJobView tenant-tz scheduled date', () => {
  // 2026-03-14T14:00:00Z: after US DST start → NY is EDT (UTC-4).
  const scheduledJob = { ...mockJob, scheduledStart: '2026-03-14T14:00:00Z' };

  beforeEach(() => {
    mockFetcher.mockReset();
    mockFetcher.mockImplementation((path: string) => {
      if (path.startsWith('/api/jobs/')) {
        return Promise.resolve(new Response(JSON.stringify(scheduledJob), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
    });
  });

  function renderInTz(timezone: string) {
    return render(
      <TenantTimezoneProvider overrideTimezone={timezone}>
        <MemoryRouter>
          <TechJobView id="j1" />
        </MemoryRouter>
      </TenantTimezoneProvider>,
    );
  }

  it('renders the hero schedule in the tenant tz (NY), independent of process TZ', async () => {
    renderInTz('America/New_York');
    // 14:00Z EDT → Mar 14 · 10:00 AM.
    expect(await screen.findByText(/Mar 14\s*·\s*10:00\s*AM/)).toBeInTheDocument();
  });

  it('renders the SAME instant differently under a different tenant tz (LA)', async () => {
    renderInTz('America/Los_Angeles');
    // Same instant, LA (UTC-7) → Mar 14 · 7:00 AM.
    expect(await screen.findByText(/Mar 14\s*·\s*7:00\s*AM/)).toBeInTheDocument();
  });
});
