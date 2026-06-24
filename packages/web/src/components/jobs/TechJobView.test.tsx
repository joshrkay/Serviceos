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
