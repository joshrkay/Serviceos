import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const apiFetchMock = vi.fn();
vi.mock('../../utils/api-fetch', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    success: (msg: string) => toastSuccess(msg),
    error: (msg: string) => toastError(msg),
  },
}));

import { CalendarSyncSheet } from './CalendarSyncSheet';

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}): Response {
  const ok = init.ok ?? true;
  return {
    ok,
    status: init.status ?? (ok ? 200 : 500),
    statusText: ok ? 'OK' : 'Error',
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('CalendarSyncSheet — Tier 4 Calendar sync (PR 1)', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    toastSuccess.mockReset();
    toastError.mockReset();
  });

  it('renders the not-connected empty state when no integration exists', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse({ data: null }));
    render(<CalendarSyncSheet onClose={() => {}} />);
    await screen.findByTestId('calendar-sync-not-connected');
    expect(screen.getByTestId('calendar-sync-connect')).toBeInTheDocument();
  });

  it('shows connected state with email when an active integration exists', async () => {
    apiFetchMock.mockResolvedValueOnce(
      jsonResponse({
        data: {
          id: 'int-1',
          provider: 'google',
          status: 'active',
          externalAccountEmail: 'jane@example.com',
          calendarId: 'primary',
          createdAt: '2026-05-01T00:00:00Z',
          updatedAt: '2026-05-01T00:00:00Z',
        },
      }),
    );
    render(<CalendarSyncSheet onClose={() => {}} />);
    const connected = await screen.findByTestId('calendar-sync-connected');
    expect(connected).toHaveTextContent('jane@example.com');
    expect(screen.getByTestId('calendar-sync-disconnect')).toBeInTheDocument();
  });

  it('shows expired state when status is expired and offers reconnect', async () => {
    apiFetchMock.mockResolvedValueOnce(
      jsonResponse({
        data: {
          id: 'int-1',
          provider: 'google',
          status: 'expired',
          externalAccountEmail: 'jane@example.com',
          calendarId: 'primary',
          createdAt: '2026-05-01T00:00:00Z',
          updatedAt: '2026-05-01T00:00:00Z',
        },
      }),
    );
    render(<CalendarSyncSheet onClose={() => {}} />);
    await screen.findByTestId('calendar-sync-expired');
    const btn = screen.getByTestId('calendar-sync-connect');
    expect(btn).toHaveTextContent(/Reconnect/i);
  });

  it('clicking Connect POSTs and redirects to the returned Google URL', async () => {
    const assignSpy = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, assign: assignSpy },
    });
    apiFetchMock.mockResolvedValueOnce(jsonResponse({ data: null }));
    apiFetchMock.mockResolvedValueOnce(
      jsonResponse({ url: 'https://accounts.google.com/o/oauth2/v2/auth?...' }),
    );
    render(<CalendarSyncSheet onClose={() => {}} />);
    fireEvent.click(await screen.findByTestId('calendar-sync-connect'));

    await waitFor(() =>
      expect(assignSpy).toHaveBeenCalledWith(
        'https://accounts.google.com/o/oauth2/v2/auth?...',
      ),
    );
    const postCall = apiFetchMock.mock.calls.find(
      (c) => c[1] && (c[1] as RequestInit).method === 'POST',
    );
    expect(postCall![0]).toBe('/api/calendar-integrations/google/connect');
  });

  it('clicking Disconnect DELETEs and flips to revoked', async () => {
    apiFetchMock.mockResolvedValueOnce(
      jsonResponse({
        data: {
          id: 'int-1',
          provider: 'google',
          status: 'active',
          externalAccountEmail: 'jane@example.com',
          calendarId: 'primary',
          createdAt: '2026-05-01T00:00:00Z',
          updatedAt: '2026-05-01T00:00:00Z',
        },
      }),
    );
    apiFetchMock.mockResolvedValueOnce(jsonResponse({ revoked: true }));

    render(<CalendarSyncSheet onClose={() => {}} />);
    fireEvent.click(await screen.findByTestId('calendar-sync-disconnect'));

    await waitFor(() => {
      expect(toastSuccess).toHaveBeenCalledWith('Calendar disconnected');
    });
    // Connect button reappears since status is now revoked.
    await screen.findByTestId('calendar-sync-connect');
  });

  it('surfaces an error toast when Connect fails', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse({ data: null }));
    apiFetchMock.mockResolvedValueOnce(
      jsonResponse({ message: 'not configured' }, { ok: false, status: 400 }),
    );
    render(<CalendarSyncSheet onClose={() => {}} />);
    fireEvent.click(await screen.findByTestId('calendar-sync-connect'));

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith('not configured');
    });
  });
});
