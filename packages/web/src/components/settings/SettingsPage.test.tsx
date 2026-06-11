import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
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
});
