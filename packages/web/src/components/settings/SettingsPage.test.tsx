import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { MemoryRouter } from 'react-router';
import { SettingsPage } from './SettingsPage';

vi.mock('../../hooks/useMe', () => ({
  useMe: () => ({
    me: {
      tenant_id: '11111111-1111-4111-8111-111111111111',
      role: 'owner',
    },
    isLoading: false,
    error: null,
    switchMode: vi.fn(),
    refetch: vi.fn(),
  }),
}));

describe('SettingsPage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders Price book settings item', () => {
    render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>
    );

    expect(screen.getByText('Price book')).toBeInTheDocument();
  });

  it('shows tenant-scoped intake link when me is loaded', () => {
    render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>
    );

    expect(
      screen.getByText(/\/intake\?t=11111111-1111-4111-8111-111111111111/),
    ).toBeInTheDocument();
  });

  it('surfaces an error with a retry when the main settings load fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/settings') && !url.includes('/api/settings/language')) {
        return Promise.resolve({ ok: false, status: 500, json: async () => ({}) } as Response);
      }
      return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
    });

    render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>
    );

    // The error/retry affordance surfaces instead of a silent blank.
    expect(await screen.findByTestId('settings-load-error')).toBeInTheDocument();
    expect(screen.getByTestId('settings-load-retry')).toBeInTheDocument();
    // The page itself still renders (non-critical sub-loads don't block it).
    await waitFor(() => expect(screen.getByText('Price book')).toBeInTheDocument());
  });
});
