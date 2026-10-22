/**
 * D-044 — returning from Google's sign-in: a connection that worked but whose
 * review link could not follow it is told to the owner, never only audited.
 */
import { render, waitFor } from '@testing-library/react';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { MemoryRouter } from 'react-router';

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), {
    success: (msg: string) => toastSuccess(msg),
    error: (msg: string) => toastError(msg),
  }),
  Toaster: () => null,
}));

import { SettingsPage } from './SettingsPage';

function returnTo(search: string) {
  window.history.replaceState(null, '', `/settings${search}`);
  render(
    <MemoryRouter>
      <SettingsPage />
    </MemoryRouter>,
  );
}

describe('SettingsPage — Google Business sign-in return', () => {
  afterEach(() => {
    toastSuccess.mockReset();
    toastError.mockReset();
    window.history.replaceState(null, '', '/');
  });

  it('warns when the review link could not be updated', async () => {
    returnTo('?googlebusiness_connected=1&googlebusiness_review_link=failed');
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('Google Business connected'));
    expect(toastError).toHaveBeenCalledWith(
      "Your Google review link couldn't be updated. Add it under Public review links.",
    );
    expect(window.location.search).toBe('');
  });

  it('says so when the old review link was removed', async () => {
    returnTo('?googlebusiness_connected=1&googlebusiness_review_link=cleared');
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        'Google has no review link for this location yet, so the old one was removed.',
      ),
    );
  });

  it('shows only the success toast when the link followed the listing', async () => {
    returnTo('?googlebusiness_connected=1');
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('Google Business connected'));
    const messages = toastError.mock.calls.map(([m]) => String(m));
    expect(messages.some((m) => /review link/i.test(m))).toBe(false);
  });
});
