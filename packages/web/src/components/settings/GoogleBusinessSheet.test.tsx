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
    locationTitle: 'Acme HVAC',
    placeId: 'PID-999',
    reviewUrl: 'https://search.google.com/local/writereview?placeid=PID-999',
    locationStatus: 'connected',
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
          backoffReason: 'auth',
        }),
      }),
    );
    render(<GoogleBusinessSheet onClose={() => {}} />);
    await screen.findByTestId('googlebusiness-attention');
    // Reconnect stays available so the operator can self-heal.
    expect(screen.getByTestId('googlebusiness-connect')).toBeInTheDocument();
  });

  it('Google throttling does not ask the owner to reconnect', async () => {
    apiFetchMock.mockResolvedValueOnce(
      jsonResponse({
        data: connectedIntegration({ backoffUntil: '2100-01-01T00:00:00Z', backoffReason: 'quota' }),
      }),
    );
    render(<GoogleBusinessSheet onClose={() => {}} />);
    await screen.findByTestId('googlebusiness-connected');
    expect(screen.queryByTestId('googlebusiness-attention')).toBeNull();
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

  it('shows the picker straight away when the account has several locations, and saves the pick', async () => {
    apiFetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          data: connectedIntegration({
            locationId: null,
            locationTitle: null,
            placeId: null,
            reviewUrl: null,
            locationStatus: 'needs_selection',
          }),
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: [
            { locationId: '999', title: 'Acme HVAC', placeId: 'P9', reviewUrl: null },
            { locationId: '1000', title: 'Acme Plumbing', placeId: 'P10', reviewUrl: null },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            locationId: '1000',
            locationTitle: 'Acme Plumbing',
            placeId: 'P10',
            reviewUrl: null,
            locationStatus: 'connected',
          },
        }),
      );
    render(<GoogleBusinessSheet onClose={() => {}} />);
    const pick = await screen.findByTestId('googlebusiness-pick-1000');
    expect(pick.className).toContain('min-h-11');
    fireEvent.click(pick);
    await screen.findByTestId('googlebusiness-connected');
    expect(screen.getByText(/Acme Plumbing/)).toBeInTheDocument();
    const putCall = apiFetchMock.mock.calls[2];
    expect(putCall[0]).toBe('/api/googlebusiness-integrations/google/location');
    expect(putCall[1]).toMatchObject({ method: 'PUT', body: JSON.stringify({ locationId: '1000' }) });
  });

  it('offers Change location when connected', async () => {
    apiFetchMock
      .mockResolvedValueOnce(jsonResponse({ data: connectedIntegration() }))
      .mockResolvedValueOnce(
        jsonResponse({ data: [{ locationId: '999', title: 'Acme HVAC', placeId: null, reviewUrl: null }] }),
      );
    render(<GoogleBusinessSheet onClose={() => {}} />);
    fireEvent.click(await screen.findByTestId('googlebusiness-change-location'));
    await screen.findByTestId('googlebusiness-picker');
    expect(screen.getByTestId('googlebusiness-pick-999')).toBeInTheDocument();
  });

  it('shows an explicit no-location state with a reconnect action', async () => {
    apiFetchMock.mockResolvedValueOnce(
      jsonResponse({
        data: connectedIntegration({ locationId: null, locationTitle: null, locationStatus: 'no_location' }),
      }),
    );
    render(<GoogleBusinessSheet onClose={() => {}} />);
    await screen.findByTestId('googlebusiness-no-location');
    expect(screen.getByTestId('googlebusiness-connect')).toBeInTheDocument();
    expect(screen.queryByTestId('googlebusiness-change-location')).toBeNull();
  });
});

