// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  back: vi.fn(),
  replace: vi.fn(),
  api: vi.fn(),
  signOut: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('expo-router', () => ({
  useRouter: () => ({ back: h.back, push: vi.fn(), replace: h.replace }),
}));
vi.mock('../lib/useApiClient', () => ({ useApiClient: () => h.api }));
// The screen signs out via Clerk DIRECTLY — using useSignOut would fire an
// authenticated device-token DELETE that the deleted membership can only 401.
vi.mock('@clerk/clerk-expo', () => ({ useAuth: () => ({ signOut: h.signOut }) }));

// eslint-disable-next-line import/first
import DeleteAccount from '../../app/(tabs)/settings/delete-account';

beforeEach(() => {
  vi.clearAllMocks();
  h.signOut.mockResolvedValue(undefined);
});

afterEach(() => cleanup());

describe('Delete account screen (guideline 5.1.1(v))', () => {
  it('requires an explicit second confirmation before calling the API', () => {
    const { getByText, queryByText } = render(createElement(DeleteAccount));
    expect(getByText('Delete my account')).toBeTruthy();
    expect(queryByText('Yes, permanently delete my account')).toBeNull();

    fireEvent.click(getByText('Delete my account'));
    expect(getByText('Yes, permanently delete my account')).toBeTruthy();
    expect(h.api).not.toHaveBeenCalled();
  });

  it('cancel backs out of the confirmation step without calling the API', () => {
    const { getByText, queryByText } = render(createElement(DeleteAccount));
    fireEvent.click(getByText('Delete my account'));
    fireEvent.click(getByText('Cancel'));
    expect(queryByText('Yes, permanently delete my account')).toBeNull();
    expect(h.api).not.toHaveBeenCalled();
  });

  it('DELETEs /api/users/me, signs out, and lands on sign-in on success', async () => {
    h.api.mockResolvedValue({ ok: true, status: 200, json: async () => ({ deleted: true }) });
    const { getByText } = render(createElement(DeleteAccount));
    fireEvent.click(getByText('Delete my account'));
    fireEvent.click(getByText('Yes, permanently delete my account'));

    await waitFor(() =>
      expect(h.api).toHaveBeenCalledWith('/api/users/me', { method: 'DELETE' }),
    );
    await waitFor(() => expect(h.signOut).toHaveBeenCalled());
    await waitFor(() => expect(h.replace).toHaveBeenCalledWith('/sign-in'));
  });

  it('surfaces the last-owner 409 message and does NOT sign out', async () => {
    h.api.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({
        error: 'LAST_OWNER',
        message: 'You are the only owner. Transfer ownership to a teammate first.',
      }),
    });
    const { getByText, findByText } = render(createElement(DeleteAccount));
    fireEvent.click(getByText('Delete my account'));
    fireEvent.click(getByText('Yes, permanently delete my account'));

    expect(
      await findByText('You are the only owner. Transfer ownership to a teammate first.'),
    ).toBeTruthy();
    expect(h.signOut).not.toHaveBeenCalled();
    expect(h.replace).not.toHaveBeenCalled();
  });

  it('surfaces the server support instruction on an unconfirmable-deletion 502', async () => {
    // The account is left durably deactivated server-side; the server
    // message carries the only recovery path and must not be replaced by
    // generic retry copy (a retry cannot authenticate anymore).
    h.api.mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => ({
        error: 'ACCOUNT_DELETE_FAILED',
        message:
          'We could not confirm the deletion with the sign-in provider. Your account is deactivated; contact support to finish or reverse it.',
      }),
    });
    const { getByText, findByText } = render(createElement(DeleteAccount));
    fireEvent.click(getByText('Delete my account'));
    fireEvent.click(getByText('Yes, permanently delete my account'));

    expect(await findByText(/contact support to finish or reverse it/)).toBeTruthy();
    expect(h.replace).not.toHaveBeenCalled();
  });

  it('shows a retryable error on a server failure', async () => {
    h.api.mockResolvedValue({ ok: false, status: 502, json: async () => ({}) });
    const { getByText, findByText } = render(createElement(DeleteAccount));
    fireEvent.click(getByText('Delete my account'));
    fireEvent.click(getByText('Yes, permanently delete my account'));

    expect(
      await findByText('Could not delete your account right now. Please try again.'),
    ).toBeTruthy();
    expect(h.replace).not.toHaveBeenCalled();
  });

  it('all interactive elements meet the >=44px contract', () => {
    const { container, getByText } = render(createElement(DeleteAccount));
    for (const b of Array.from(container.querySelectorAll('button'))) {
      expect(b.className).toMatch(/\bmin-h-11\b/);
    }
    fireEvent.click(getByText('Delete my account'));
    for (const b of Array.from(container.querySelectorAll('button'))) {
      expect(b.className).toMatch(/\bmin-h-11\b/);
    }
  });
});
