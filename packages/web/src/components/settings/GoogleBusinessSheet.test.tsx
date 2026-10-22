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

  describe('D-044 — choosing the Google location', () => {
    const LOCATIONS = [
      {
        accountId: '123',
        locationId: '999',
        title: 'Acme Plumbing',
        address: '1 Main St, Austin',
        placeId: 'ChIJ1',
        reviewUrl: 'https://g.page/r/review-999',
      },
      {
        accountId: '456',
        locationId: '555',
        title: 'Acme North',
        address: null,
        placeId: 'ChIJ2',
        reviewUrl: 'https://g.page/r/review-555',
      },
    ];

    it('several locations: loads the picker and a tap saves the location', async () => {
      apiFetchMock
        .mockResolvedValueOnce(
          jsonResponse({
            data: connectedIntegration({ locationId: null, locationState: 'needs_pick' }),
          }),
        )
        .mockResolvedValueOnce(jsonResponse({ data: LOCATIONS }))
        .mockResolvedValueOnce(
          jsonResponse({
            data: connectedIntegration({
              accountId: '456',
              locationId: '555',
              locationTitle: 'Acme North',
              reviewUrl: 'https://g.page/r/review-555',
              locationState: 'connected',
            }),
            reviewUrlFilled: true,
          }),
        );
      const onReviewUrlChange = vi.fn();
      render(<GoogleBusinessSheet onClose={() => {}} onReviewUrlChange={onReviewUrlChange} />);
      await screen.findByTestId('googlebusiness-location-picker');
      expect(apiFetchMock).toHaveBeenNthCalledWith(
        2,
        '/api/googlebusiness-integrations/google/locations',
      );
      const options = screen.getAllByTestId('googlebusiness-location-option');
      expect(options).toHaveLength(2);
      // Glove-sized, full-width targets (jsdom class contract; the
      // Playwright spec measures the rendered layout).
      for (const option of options) {
        expect(option.className).toContain('min-h-11');
        expect(option.className).toContain('w-full');
      }

      fireEvent.click(screen.getByText('Acme North'));
      await waitFor(() =>
        expect(apiFetchMock).toHaveBeenNthCalledWith(
          3,
          '/api/googlebusiness-integrations/google/location',
          expect.objectContaining({
            method: 'PUT',
            body: JSON.stringify({ accountId: '456', locationId: '555' }),
          }),
        ),
      );
      await waitFor(() =>
        expect(screen.queryByTestId('googlebusiness-location-picker')).toBeNull(),
      );
      expect(screen.getByText('Business location: Acme North')).toBeInTheDocument();
      expect(screen.getByTestId('googlebusiness-review-link')).toHaveTextContent(
        'https://g.page/r/review-555',
      );
      expect(toastSuccess).toHaveBeenCalledWith(
        'Acme North connected. Your Google review link is set.',
      );
      // The Settings page's review-link field follows the server.
      expect(onReviewUrlChange).toHaveBeenCalledWith('https://g.page/r/review-555');
    });

    it('tells the owner when the old review link was removed', async () => {
      apiFetchMock
        .mockResolvedValueOnce(
          jsonResponse({
            data: connectedIntegration({ locationId: null, locationState: 'needs_pick' }),
          }),
        )
        .mockResolvedValueOnce(jsonResponse({ data: LOCATIONS }))
        .mockResolvedValueOnce(
          jsonResponse({
            data: connectedIntegration({
              accountId: '456',
              locationId: '555',
              locationTitle: 'Acme North',
              reviewUrl: null,
              locationState: 'connected',
            }),
            reviewUrlFilled: false,
            reviewUrlCleared: true,
          }),
        );
      render(<GoogleBusinessSheet onClose={() => {}} />);
      await screen.findByTestId('googlebusiness-location-picker');
      fireEvent.click(screen.getByText('Acme North'));
      await waitFor(() =>
        expect(toastSuccess).toHaveBeenCalledWith(
          'Acme North connected. Google has no review link for it yet, so the old one was removed.',
        ),
      );
    });

    it('no Business Profile yet: says so and offers Check again', async () => {
      apiFetchMock
        .mockResolvedValueOnce(
          jsonResponse({
            data: connectedIntegration({ locationId: null, locationState: 'no_location' }),
          }),
        )
        .mockResolvedValueOnce(jsonResponse({ data: [] }));
      render(<GoogleBusinessSheet onClose={() => {}} />);
      await screen.findByTestId('googlebusiness-no-location');
      const again = screen.getByTestId('googlebusiness-check-again');
      expect(again.className).toContain('min-h-11');
      fireEvent.click(again);
      await screen.findByTestId('googlebusiness-no-locations-found');
      // The empty picker keeps a way to try again.
      apiFetchMock.mockResolvedValueOnce(jsonResponse({ data: LOCATIONS }));
      const recheck = screen.getByTestId('googlebusiness-recheck-locations');
      expect(recheck.className).toContain('min-h-11');
      fireEvent.click(recheck);
      await waitFor(() =>
        expect(screen.getAllByTestId('googlebusiness-location-option')).toHaveLength(2),
      );
    });

    it('#1764: no Business Profile shows the walkthrough with working Google links and glove targets', async () => {
      apiFetchMock.mockResolvedValueOnce(
        jsonResponse({ data: connectedIntegration({ locationId: null, locationState: 'no_location' }) }),
      );
      render(<GoogleBusinessSheet onClose={() => {}} />);
      await screen.findByTestId('googlebusiness-no-location');
      expect(screen.getByTestId('googlebusiness-walkthrough-steps').children).toHaveLength(3);
      expect(screen.getByText(/postcard, phone, text, email or a short video/)).toBeInTheDocument();
      expect(screen.getByText(/You have to finish this yourself/)).toBeInTheDocument();
      const create = screen.getByTestId('googlebusiness-create-profile');
      expect(create).toHaveAttribute('href', 'https://business.google.com/create');
      expect(create).toHaveAttribute('target', '_blank');
      expect(create.getAttribute('rel')).toContain('noopener');
      expect(screen.getByTestId('googlebusiness-verify-help')).toHaveAttribute(
        'href',
        expect.stringContaining('support.google.com/business'),
      );
      for (const id of ['googlebusiness-create-profile', 'googlebusiness-verify-help', 'googlebusiness-check-again']) {
        expect(screen.getByTestId(id).className).toContain('min-h-11');
        expect(screen.getByTestId(id).className).toContain('w-full');
      }
    });

    it('#1764: re-checks on its own and hands off to the picker once a location appears', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        apiFetchMock
          .mockResolvedValueOnce(
            jsonResponse({ data: connectedIntegration({ locationId: null, locationState: 'no_location' }) }),
          )
          // First timed re-check: still nothing, the walkthrough stays.
          .mockResolvedValueOnce(jsonResponse({ data: [] }))
          .mockResolvedValueOnce(jsonResponse({ data: LOCATIONS }));
        render(<GoogleBusinessSheet onClose={() => {}} />);
        await screen.findByTestId('googlebusiness-no-location');
        await vi.advanceTimersByTimeAsync(60_000);
        await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(2));
        expect(screen.getByTestId('googlebusiness-no-location')).toBeInTheDocument();
        expect(screen.queryByTestId('googlebusiness-no-locations-found')).toBeNull();
        await vi.advanceTimersByTimeAsync(60_000);
        await waitFor(() =>
          expect(screen.getAllByTestId('googlebusiness-location-option')).toHaveLength(2),
        );
        expect(screen.queryByTestId('googlebusiness-no-location')).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it('needs a pick but the automatic load failed: offers a retry', async () => {
      apiFetchMock
        .mockResolvedValueOnce(
          jsonResponse({
            data: connectedIntegration({ locationId: null, locationState: 'needs_pick' }),
          }),
        )
        .mockResolvedValueOnce(jsonResponse({ error: { message: 'Google is down' } }, { ok: false, status: 502 }))
        .mockResolvedValueOnce(jsonResponse({ data: LOCATIONS }));
      render(<GoogleBusinessSheet onClose={() => {}} />);
      const retry = await screen.findByTestId('googlebusiness-load-locations');
      expect(retry.className).toContain('min-h-11');
      fireEvent.click(retry);
      await screen.findByTestId('googlebusiness-location-picker');
    });

    it('connected: Change location opens the picker with the current one marked', async () => {
      apiFetchMock
        .mockResolvedValueOnce(
          jsonResponse({
            data: connectedIntegration({
              locationTitle: 'Acme Plumbing',
              locationState: 'connected',
            }),
          }),
        )
        .mockResolvedValueOnce(jsonResponse({ data: LOCATIONS }));
      render(<GoogleBusinessSheet onClose={() => {}} />);
      fireEvent.click(await screen.findByTestId('googlebusiness-change-location'));
      await screen.findByTestId('googlebusiness-location-picker');
      expect(screen.getByText('Acme Plumbing (current)').closest('button')).toBeDisabled();
    });

    it('connected: a saved listing Google no longer lists is dropped and the owner told', async () => {
      const onReviewUrlChange = vi.fn();
      apiFetchMock
        .mockResolvedValueOnce(
          jsonResponse({
            data: connectedIntegration({ locationTitle: 'Acme Plumbing', locationState: 'connected' }),
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse({
            data: LOCATIONS,
            listingRemoved: true,
            reviewUrlCleared: true,
            integration: connectedIntegration({
              accountId: null,
              locationId: null,
              locationTitle: null,
              locationState: 'needs_pick',
            }),
          }),
        );
      render(<GoogleBusinessSheet onClose={() => {}} onReviewUrlChange={onReviewUrlChange} />);
      fireEvent.click(await screen.findByTestId('googlebusiness-change-location'));
      await screen.findByTestId('googlebusiness-location-picker');
      expect(onReviewUrlChange).toHaveBeenCalledWith(null);
      expect(toastError).toHaveBeenCalledWith(
        expect.stringContaining('no longer on this account, so its review link was removed'),
      );
      expect(screen.queryByText('Acme Plumbing (current)')).toBeNull();
    });

    it('connected: a review link Google added to the saved listing is picked up', async () => {
      const onReviewUrlChange = vi.fn();
      apiFetchMock
        .mockResolvedValueOnce(
          jsonResponse({
            data: connectedIntegration({ locationTitle: 'Acme Plumbing', locationState: 'connected' }),
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse({
            data: LOCATIONS,
            reviewUrlFilled: true,
            reviewUrlCleared: false,
            integration: connectedIntegration({
              locationTitle: 'Acme Plumbing',
              locationState: 'connected',
              reviewUrl: 'https://g.page/r/new',
            }),
          }),
        );
      render(<GoogleBusinessSheet onClose={() => {}} onReviewUrlChange={onReviewUrlChange} />);
      fireEvent.click(await screen.findByTestId('googlebusiness-change-location'));
      await screen.findByTestId('googlebusiness-location-picker');
      expect(onReviewUrlChange).toHaveBeenCalledWith('https://g.page/r/new');
      expect(toastSuccess).toHaveBeenCalledWith(expect.stringContaining('review link'));
    });

    it('a failed save shows the API reason', async () => {
      apiFetchMock
        .mockResolvedValueOnce(
          jsonResponse({
            data: connectedIntegration({ locationId: null, locationState: 'needs_pick' }),
          }),
        )
        .mockResolvedValueOnce(jsonResponse({ data: LOCATIONS }))
        .mockResolvedValueOnce(
          jsonResponse(
            { message: 'That location is not on your Google account' },
            { ok: false, status: 400 },
          ),
        );
      render(<GoogleBusinessSheet onClose={() => {}} />);
      await screen.findByTestId('googlebusiness-location-picker');
      fireEvent.click(screen.getByText('Acme Plumbing'));
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'That location is not on your Google account',
      );
    });
  });
});

