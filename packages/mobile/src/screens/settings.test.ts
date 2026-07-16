// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
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
  getCallbackNumber: vi.fn().mockResolvedValue(null),
  saveCallbackNumber: vi.fn(),
}));

vi.mock('expo-router', () => ({
  useRouter: () => ({ back: h.back, push: vi.fn(), replace: vi.fn() }),
}));
vi.mock('../hooks/useMe', () => ({
  useMe: () => ({ me: h.me, isLoading: h.isLoading, error: h.error, switchMode: vi.fn(), refetch: vi.fn() }),
}));
vi.mock('../push/useSignOut', () => ({ useSignOut: () => h.signOut }));
vi.mock('../calls/callbackStorage', () => ({
  getCallbackNumber: h.getCallbackNumber,
  saveCallbackNumber: h.saveCallbackNumber,
}));
vi.mock('../hooks/useNotificationPreferences', () => ({
  useNotificationPreferences: () => ({
    preferences: {},
    isLoading: false,
    error: null,
    setEnabled: vi.fn(),
    reload: vi.fn(),
  }),
}));

// eslint-disable-next-line import/first
import Settings from '../../app/(tabs)/settings/index';

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
  });

  it('lists team, templates, and digests — not admin voice stubs', () => {
    const { getByText, queryByText } = render(createElement(Settings));
    expect(getByText('Team & roles')).toBeTruthy();
    expect(getByText('Message templates')).toBeTruthy();
    expect(getByText('Weekly digest')).toBeTruthy();
    expect(getByText('End of day review')).toBeTruthy();
    expect(queryByText('Voice settings')).toBeNull();
    expect(queryByText('Brand voice')).toBeNull();
  });

  it('signs out from a >=44px tap target', () => {
    const { getByText } = render(createElement(Settings));
    const button = getByText('Sign out').closest('button')!;
    expect(button.className).toMatch(/\bmin-h-11\b/);
    fireEvent.click(button);
    expect(h.signOut).toHaveBeenCalledTimes(1);
  });

  it('saves a valid callback number for click-to-call', async () => {
    h.saveCallbackNumber.mockResolvedValue('+15551234567');
    const { getByPlaceholderText, getByText, findByText } = render(createElement(Settings));
    fireEvent.change(getByPlaceholderText('+1 555 123 4567'), { target: { value: '555 123 4567' } });
    fireEvent.click(getByText('Save callback number').closest('button')!);
    await waitFor(() => expect(h.saveCallbackNumber).toHaveBeenCalledWith('555 123 4567'));
    expect(await findByText('Saved.')).toBeTruthy();
  });

  it('rejects an invalid callback number', async () => {
    h.saveCallbackNumber.mockResolvedValue(null);
    const { getByPlaceholderText, getByText, findByText } = render(createElement(Settings));
    fireEvent.change(getByPlaceholderText('+1 555 123 4567'), { target: { value: 'nope' } });
    fireEvent.click(getByText('Save callback number').closest('button')!);
    expect(await findByText('Enter a valid phone number.')).toBeTruthy();
  });
});
