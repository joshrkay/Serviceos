import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter } from 'react-router';

// TechJobView fetches the job via useApiClient on mount and renders a
// loading state until that resolves; stub the client to return a minimal
// job synchronously so the delay UI is in the DOM by the time we assert.
// useApiClient must return a stable function reference across renders;
// the real hook does this via useCallback, and TechJobView's loadJob /
// loadNotes useCallbacks list apiFetch in deps. A fresh arrow per call
// would invalidate the effect every render and never settle isLoading.
const apiFetchStub = async (url: string) => {
  const body = url.startsWith('/api/jobs/')
    ? { id: 'j1', status: 'in_progress', serviceType: 'HVAC' }
    : { data: [] };
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response;
};
vi.mock('../../lib/apiClient', () => ({
  useApiClient: () => apiFetchStub,
}));

import { TechJobView } from './TechJobView';

describe('TechJobView delay acknowledgement prompt', () => {
  it('renders fixed delay options and toggles with Yes/No', async () => {
    render(
      <MemoryRouter>
        <TechJobView id="j1" />
      </MemoryRouter>
    );

    expect(await screen.findByText('Running behind?')).toBeInTheDocument();
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
