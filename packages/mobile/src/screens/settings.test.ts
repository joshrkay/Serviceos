// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  back: vi.fn(),
  signOut: vi.fn(),
  me: {
    user_id: 'u',
    tenant_id: 't-123',
    role: 'supervisor',
    can_field_serve: true,
    current_mode: 'both',
    mode_changed_at: null,
    permissions: [] as string[],
    backup_supervisor_user_id: null,
    unsupervised_proposal_routing: 'queue_only' as const,
  } as unknown,
  isLoading: false,
  error: null as Error | null,
}));

vi.mock('expo-router', () => ({
  useRouter: () => ({ back: h.back, push: vi.fn(), replace: vi.fn() }),
}));
vi.mock('../hooks/useMe', () => ({
  useMe: () => ({ me: h.me, isLoading: h.isLoading, error: h.error, switchMode: vi.fn(), refetch: vi.fn() }),
}));
vi.mock('../push/useSignOut', () => ({ useSignOut: () => h.signOut }));

// eslint-disable-next-line import/first
import Settings from '../../app/settings';

beforeEach(() => {
  vi.clearAllMocks();
  h.isLoading = false;
  h.error = null;
});

afterEach(() => cleanup());

describe('Settings screen', () => {
  it('renders the business info rows from /api/me', () => {
    const { getByText } = render(createElement(Settings));
    expect(getByText('Role')).toBeTruthy();
    expect(getByText('supervisor')).toBeTruthy();
    expect(getByText('Field-capable')).toBeTruthy();
    expect(getByText('Yes')).toBeTruthy();
    expect(getByText('t-123')).toBeTruthy();
  });

  it('signs out from a >=44px tap target', () => {
    const { getByText } = render(createElement(Settings));
    const button = getByText('Sign out').closest('button')!;
    expect(button.className).toMatch(/\bmin-h-11\b/);
    fireEvent.click(button);
    expect(h.signOut).toHaveBeenCalledTimes(1);
  });

  it('Back is a >=44px tap target', () => {
    const { getByText } = render(createElement(Settings));
    const back = getByText('‹ Back').closest('button')!;
    expect(back.className).toMatch(/\bmin-h-11\b/);
    fireEvent.click(back);
    expect(h.back).toHaveBeenCalledTimes(1);
  });
});
