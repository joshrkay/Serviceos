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

import { GoogleBusinessSheet } from './GoogleBusinessSheet';

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

function connectedIntegration(overrides: Record<string, unknown> = {}) {
  return {
    id: 'int-1',
    provider: 'google_business',
    status: 'full_readiness',
    accountId: '123',
    locationId: '999',
    updatedAt: '2026-08-01T00:00:00Z',
    lastSuccessfulPollAt: '2026-08-05T09:00:00Z',
    backoffUntil: null,
    ...overrides,
  };
}

describe('GoogleBusinessSheet', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    toastSuccess.mockReset();
    toastError.mockReset();
  });

  it('renders the not-connected empty state when no integration exists', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse({ data: null }));
    render(<GoogleBusinessSheet onClose={() => {}} />);
    await screen.findByTestId('googlebusiness-not-connected');
    expect(screen.getByTestId('googlebusiness-connect')).toBeInTheDocument();
  });

  it('shows the connected state with the business location when connected', async () => {
    apiFetchMock.mockResolvedValueOnce(
      jsonResponse({ data: connectedIntegration() }),
    );
    render(<GoogleBusinessSheet onClose={() => {}} />);
    await screen.findByTestId('googlebusiness-connected');
    expect(screen.getByTestId('googlebusiness-disconnect')).toBeInTheDocument();
  });

  it('shows a visible attention state while review polling is backed off', async () => {
    apiFetchMock.mockResolvedValueOnce(
      jsonResponse({
        data: connectedIntegration({
          // Far-future backoff — credentials are broken until reconnect.
          backoffUntil: '2100-01-01T00:00:00Z',
        }),
      }),
    );
    render(<GoogleBusinessSheet onClose={() => {}} />);
    await screen.findByTestId('googlebusiness-attention');
    // Reconnect stays available so the operator can self-heal.
    expect(screen.getByTestId('googlebusiness-connect')).toBeInTheDocument();
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
    render(<GoogleBusinessSheet onClose={() => {}} />);
    fireEvent.click(await screen.findByTestId('googlebusiness-connect'));

    await waitFor(() =>
      expect(assignSpy).toHaveBeenCalledWith(
        'https://accounts.google.com/o/oauth2/v2/auth?...',
      ),
    );
    const postCall = apiFetchMock.mock.calls.find(
      (c) => c[1] && (c[1] as RequestInit).method === 'POST',
    );
    expect(postCall![0]).toBe('/api/googlebusiness-integrations/google/connect');
  });

  it('clicking Disconnect DELETEs and flips to the empty state', async () => {
    apiFetchMock.mockResolvedValueOnce(
      jsonResponse({ data: connectedIntegration() }),
    );
    apiFetchMock.mockResolvedValueOnce(jsonResponse({ revoked: true }));
    render(<GoogleBusinessSheet onClose={() => {}} />);
    fireEvent.click(await screen.findByTestId('googlebusiness-disconnect'));

    await waitFor(() =>
      expect(screen.getByTestId('googlebusiness-not-connected')).toBeInTheDocument(),
    );
    const deleteCall = apiFetchMock.mock.calls.find(
      (c) => c[1] && (c[1] as RequestInit).method === 'DELETE',
    );
    expect(deleteCall![0]).toBe('/api/googlebusiness-integrations/google');
    expect(toastSuccess).toHaveBeenCalled();
  });

  it('surfaces a connect failure as an error message + toast', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse({ data: null }));
    apiFetchMock.mockResolvedValueOnce(
      jsonResponse(
        { message: 'Google Business integration is not configured' },
        { ok: false, status: 400 },
      ),
    );
    render(<GoogleBusinessSheet onClose={() => {}} />);
    fireEvent.click(await screen.findByTestId('googlebusiness-connect'));
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(
      screen.getByText('Google Business integration is not configured'),
    ).toBeInTheDocument();
  });
});
