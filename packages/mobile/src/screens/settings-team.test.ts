// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface TeamUser {
  id: string;
  email: string;
  role: string;
  firstName?: string;
  lastName?: string;
}

const h = vi.hoisted(() => ({
  data: [] as TeamUser[],
  isLoading: false,
  error: null as string | null,
  refetch: vi.fn(),
}));

vi.mock('expo-router', () => ({
  useRouter: () => ({ back: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));
vi.mock('../hooks/useListQuery', () => ({
  useListQuery: () => ({
    data: h.data,
    total: h.data.length,
    isLoading: h.isLoading,
    error: h.error,
    refetch: h.refetch,
  }),
}));

// eslint-disable-next-line import/first
import TeamSettings from '../../app/(tabs)/settings/team';

beforeEach(() => {
  vi.clearAllMocks();
  h.data = [];
  h.isLoading = false;
  h.error = null;
});

afterEach(() => cleanup());

describe('Team settings screen', () => {
  it('shows the empty state when there are no team members', () => {
    const { getByText } = render(createElement(TeamSettings));
    expect(getByText('Team & roles')).toBeTruthy();
    expect(getByText('No team members yet. Invitations and role edits will appear here.')).toBeTruthy();
  });

  it('renders team member rows with roles', () => {
    h.data = [
      { id: 'u1', email: 'owner@acme.test', role: 'owner', firstName: 'Pat', lastName: 'Owner' },
    ];
    const { getByText } = render(createElement(TeamSettings));
    expect(getByText('Pat Owner')).toBeTruthy();
    expect(getByText('owner')).toBeTruthy();
  });

  it('surfaces a fetch error', () => {
    h.error = 'HTTP 500';
    const { getByText } = render(createElement(TeamSettings));
    expect(getByText('HTTP 500')).toBeTruthy();
    fireEvent.click(getByText('Try again').closest('button')!);
    expect(h.refetch).toHaveBeenCalledTimes(1);
  });

  it('falls back to email when a user has no name', () => {
    h.data = [{ id: 'u2', email: 'tech@acme.test', role: 'technician' }];
    const { getByText } = render(createElement(TeamSettings));
    expect(getByText('tech@acme.test')).toBeTruthy();
  });
});
