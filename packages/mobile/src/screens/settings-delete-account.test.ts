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

  it('reconciles a lost response: /api/me probe 500 → still ambiguous, retry copy (NOT sign-out)', async () => {
    // A 429/5xx probe is a struggling server, not proof the account is
    // gone — only 401/403 confirms the membership was rejected.
    h.api
      .mockRejectedValueOnce(new Error('network dropped mid-response'))
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });
    const { getByText, findByText } = render(createElement(DeleteAccount));
    fireEvent.click(getByText('Delete my account'));
    fireEvent.click(getByText('Yes, permanently delete my account'));

    expect(
      await findByText('Could not delete your account right now. Please try again.'),
    ).toBeTruthy();
    expect(h.signOut).not.toHaveBeenCalled();
    expect(h.replace).not.toHaveBeenCalled();
  });

  it('reconciles a lost response: /api/me rejected → signs out instead of offering a doomed retry', async () => {
    h.api
      .mockRejectedValueOnce(new Error('network dropped mid-response'))
      .mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) });
    const { getByText } = render(createElement(DeleteAccount));
    fireEvent.click(getByText('Delete my account'));
    fireEvent.click(getByText('Yes, permanently delete my account'));

    await waitFor(() => expect(h.api).toHaveBeenCalledWith('/api/me'));
    await waitFor(() => expect(h.signOut).toHaveBeenCalled());
    await waitFor(() => expect(h.replace).toHaveBeenCalledWith('/sign-in'));
  });

  it('reconciles a lost response: /api/me still ok → account alive, retry copy shown', async () => {
    h.api
      .mockRejectedValueOnce(new Error('network dropped mid-response'))
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) });
    const { getByText, findByText } = render(createElement(DeleteAccount));
    fireEvent.click(getByText('Delete my account'));
    fireEvent.click(getByText('Yes, permanently delete my account'));

    expect(
      await findByText('Could not delete your account right now. Please try again.'),
    ).toBeTruthy();
    expect(h.signOut).not.toHaveBeenCalled();
    expect(h.replace).not.toHaveBeenCalled();
  });

  it('a THROWN UnauthorizedError on the DELETE (real apiFetch behavior) transitions into sign-out', async () => {
    // apiFetch never returns a persistent 401 — it throws a tagged error.
    const unauthorized = Object.assign(new Error('unauthorized'), {
      name: 'UnauthorizedError',
      status: 401,
    });
    h.api.mockRejectedValue(unauthorized);
    const { getByText } = render(createElement(DeleteAccount));
    fireEvent.click(getByText('Delete my account'));
    fireEvent.click(getByText('Yes, permanently delete my account'));

    await waitFor(() => expect(h.signOut).toHaveBeenCalled());
    await waitFor(() => expect(h.replace).toHaveBeenCalledWith('/sign-in'));
  });

  it('a thrown UnauthorizedError on the PROBE also transitions into sign-out', async () => {
    const unauthorized = Object.assign(new Error('unauthorized'), {
      name: 'UnauthorizedError',
      status: 401,
    });
    h.api
      .mockRejectedValueOnce(new Error('network dropped mid-response'))
      .mockRejectedValueOnce(unauthorized);
    const { getByText } = render(createElement(DeleteAccount));
    fireEvent.click(getByText('Delete my account'));
    fireEvent.click(getByText('Yes, permanently delete my account'));

    await waitFor(() => expect(h.signOut).toHaveBeenCalled());
    await waitFor(() => expect(h.replace).toHaveBeenCalledWith('/sign-in'));
  });

  it('a 401 on the DELETE itself (retry after landed deletion) transitions into sign-out', async () => {
    h.api.mockResolvedValue({ ok: false, status: 401, json: async () => ({}) });
    const { getByText } = render(createElement(DeleteAccount));
    fireEvent.click(getByText('Delete my account'));
    fireEvent.click(getByText('Yes, permanently delete my account'));

    await waitFor(() => expect(h.signOut).toHaveBeenCalled());
    await waitFor(() => expect(h.replace).toHaveBeenCalledWith('/sign-in'));
  });

  it('shows the restart instruction and does NOT navigate when sign-out keeps failing', async () => {
    // Navigating to /sign-in with a live cached session bounces straight
    // back into the app (root-layout auth gate) — the screen must hold.
    h.api.mockResolvedValue({ ok: true, status: 200, json: async () => ({ deleted: true }) });
    h.signOut.mockRejectedValue(new Error('offline'));
    const { getByText, findByText } = render(createElement(DeleteAccount));
    fireEvent.click(getByText('Delete my account'));
    fireEvent.click(getByText('Yes, permanently delete my account'));

    expect(await findByText(/couldn't finish signing this device out/)).toBeTruthy();
    // Two attempts were made before giving up.
    expect(h.signOut).toHaveBeenCalledTimes(2);
    expect(h.replace).not.toHaveBeenCalled();
  });

  it('retry button completes the sign-out and then navigates', async () => {
    h.api.mockResolvedValue({ ok: true, status: 200, json: async () => ({ deleted: true }) });
    h.signOut.mockRejectedValue(new Error('offline'));
    const { getByText, findByText } = render(createElement(DeleteAccount));
    fireEvent.click(getByText('Delete my account'));
    fireEvent.click(getByText('Yes, permanently delete my account'));
    await findByText(/couldn't finish signing this device out/);

    h.signOut.mockResolvedValue(undefined);
    fireEvent.click(getByText('Try signing out again'));
    await waitFor(() => expect(h.replace).toHaveBeenCalledWith('/sign-in'));
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
