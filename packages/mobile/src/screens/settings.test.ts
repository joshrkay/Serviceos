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
  deleteAccount: vi.fn().mockResolvedValue(true),
  deleteError: null as string | null,
}));

vi.mock('expo-router', () => ({
  useRouter: () => ({ back: h.back, push: vi.fn(), replace: vi.fn() }),
}));
vi.mock('../hooks/useMe', () => ({
  useMe: () => ({ me: h.me, isLoading: h.isLoading, error: h.error, switchMode: vi.fn(), refetch: vi.fn() }),
}));
vi.mock('../push/useSignOut', () => ({ useSignOut: () => h.signOut }));
vi.mock('../hooks/useDeleteAccount', () => ({
  useDeleteAccount: () => ({ phase: 'idle', error: h.deleteError, deleteAccount: h.deleteAccount }),
}));
vi.mock('../calls/callbackStorage', () => ({
  getCallbackNumber: h.getCallbackNumber,
  saveCallbackNumber: h.saveCallbackNumber,
}));

// eslint-disable-next-line import/first
import Settings from '../../app/settings';

beforeEach(() => {
  vi.clearAllMocks();
  h.isLoading = false;
  h.error = null;
  h.deleteError = null;
  h.deleteAccount.mockResolvedValue(true);
});

/** The destructive "Delete account" control is the one rendered inside a button
 * (the section heading shares the text but is a plain label). */
function deleteTrigger(getAllByText: (t: string) => HTMLElement[]): HTMLButtonElement {
  const btn = getAllByText('Delete account')
    .map((el) => el.closest('button'))
    .find(Boolean);
  if (!btn) throw new Error('Delete account button not found');
  return btn as HTMLButtonElement;
}

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

  it('saves a valid callback number for click-to-call', async () => {
    h.saveCallbackNumber.mockResolvedValue('+15551234567');
    const { getByPlaceholderText, getByText, findByText } = render(createElement(Settings));
    fireEvent.change(getByPlaceholderText('+1 555 123 4567'), { target: { value: '555 123 4567' } });
    fireEvent.click(getByText('Save').closest('button')!);
    await waitFor(() => expect(h.saveCallbackNumber).toHaveBeenCalledWith('555 123 4567'));
    expect(await findByText('Saved.')).toBeTruthy();
  });

  it('rejects an invalid callback number', async () => {
    h.saveCallbackNumber.mockResolvedValue(null);
    const { getByPlaceholderText, getByText, findByText } = render(createElement(Settings));
    fireEvent.change(getByPlaceholderText('+1 555 123 4567'), { target: { value: 'nope' } });
    fireEvent.click(getByText('Save').closest('button')!);
    expect(await findByText('Enter a valid phone number.')).toBeTruthy();
  });

  it('exposes a Delete account control on a >=44px tap target (Apple 5.1.1(v))', () => {
    const { getAllByText } = render(createElement(Settings));
    const trigger = deleteTrigger(getAllByText);
    expect(trigger.className).toMatch(/\bmin-h-11\b/);
  });

  it('requires an explicit confirm before deleting', () => {
    const { getAllByText, queryByText } = render(createElement(Settings));
    // The destructive action is not present until the owner confirms intent.
    expect(queryByText('Yes, delete everything')).toBeNull();
    fireEvent.click(deleteTrigger(getAllByText));
    expect(queryByText('Yes, delete everything')).toBeTruthy();
  });

  it('deletes the account then signs out on success', async () => {
    const { getAllByText, findByText } = render(createElement(Settings));
    fireEvent.click(deleteTrigger(getAllByText));
    fireEvent.click((await findByText('Yes, delete everything')).closest('button')!);
    await waitFor(() => expect(h.deleteAccount).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(h.signOut).toHaveBeenCalledTimes(1));
  });

  it('does not sign out when deletion fails', async () => {
    h.deleteAccount.mockResolvedValue(false);
    const { getAllByText, findByText } = render(createElement(Settings));
    fireEvent.click(deleteTrigger(getAllByText));
    fireEvent.click((await findByText('Yes, delete everything')).closest('button')!);
    await waitFor(() => expect(h.deleteAccount).toHaveBeenCalledTimes(1));
    expect(h.signOut).not.toHaveBeenCalled();
  });

  it('surfaces a deletion error from the hook', () => {
    h.deleteError = 'Only the owner can delete the account.';
    const { getByText } = render(createElement(Settings));
    expect(getByText('Only the owner can delete the account.')).toBeTruthy();
  });
});
