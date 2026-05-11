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
    expect(chip20).toHaveClass('bg-indigo-600');

    fireEvent.click(noButton);
    expect(chip10).toBeDisabled();
    expect(chip15).toBeDisabled();
    expect(chip20).toBeDisabled();
    expect(chip60).toBeDisabled();
    expect(chip20).not.toHaveClass('bg-indigo-600');
  });
});
