import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TenantTimezoneProvider, useTenantTimezone, useTenantTimezoneState } from './useTenantTimezone';

const fetchMock = vi.fn();

vi.mock('../utils/api-fetch', () => ({
  apiFetch: (...args: unknown[]) => fetchMock(...args),
}));

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function Consumer() {
  const tz = useTenantTimezone();
  const { loading } = useTenantTimezoneState();
  return (
    <div>
      <span data-testid="tz">{tz}</span>
      <span data-testid="loading">{loading ? 'yes' : 'no'}</span>
    </div>
  );
}

beforeEach(() => {
  fetchMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TenantTimezoneProvider / useTenantTimezone', () => {
  it('hydrates the timezone from /api/me on mount', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ timezone: 'America/Los_Angeles' }));

    render(
      <TenantTimezoneProvider>
        <Consumer />
      </TenantTimezoneProvider>,
    );

    expect(screen.getByTestId('tz').textContent).toBe('America/New_York');
    expect(screen.getByTestId('loading').textContent).toBe('yes');

    await waitFor(() => {
      expect(screen.getByTestId('tz').textContent).toBe('America/Los_Angeles');
      expect(screen.getByTestId('loading').textContent).toBe('no');
    });
    expect(fetchMock).toHaveBeenCalledWith('/api/me');
  });

  it('falls back to America/New_York when /api/me errors', async () => {
    fetchMock.mockResolvedValueOnce(new Response('boom', { status: 500 }));

    render(
      <TenantTimezoneProvider>
        <Consumer />
      </TenantTimezoneProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('loading').textContent).toBe('no');
    });
    expect(screen.getByTestId('tz').textContent).toBe('America/New_York');
  });

  it('falls back when /api/me payload omits the timezone field', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ user_id: 'u', tenant_id: 't' }));

    render(
      <TenantTimezoneProvider>
        <Consumer />
      </TenantTimezoneProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('loading').textContent).toBe('no');
    });
    expect(screen.getByTestId('tz').textContent).toBe('America/New_York');
  });

  it('uses the overrideTimezone prop without fetching when supplied', () => {
    render(
      <TenantTimezoneProvider overrideTimezone="Europe/Berlin">
        <Consumer />
      </TenantTimezoneProvider>,
    );

    expect(screen.getByTestId('tz').textContent).toBe('Europe/Berlin');
    expect(screen.getByTestId('loading').textContent).toBe('no');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns America/New_York when used outside the provider (defensive default)', () => {
    render(<Consumer />);
    expect(screen.getByTestId('tz').textContent).toBe('America/New_York');
  });
});
