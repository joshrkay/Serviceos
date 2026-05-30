/**
 * DncListSheet — happy-path render + add + remove flows.
 *
 * Mocks apiFetch to control the four endpoints (`GET /api/dnc`,
 * `POST /api/dnc`, `DELETE /api/dnc/:phone`). Each test asserts on the
 * observable DOM, not on internal state.
 */
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DncListSheet } from './DncListSheet';

const apiFetchMock = vi.fn();

vi.mock('../../utils/api-fetch', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('../../hooks/useTenantTimezone', () => ({
  useTenantTimezone: () => 'America/New_York',
}));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  apiFetchMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('DncListSheet', () => {
  it('hydrates the list on open', async () => {
    apiFetchMock.mockResolvedValueOnce(
      jsonResponse({
        entries: [
          { phone: '15551234567', source: 'manual_settings', createdAt: '2026-05-28T17:00:00Z' },
          { phone: '15559876543', source: 'sms_stop_reply', createdAt: '2026-05-20T10:00:00Z' },
        ],
      }),
    );

    render(<DncListSheet open onOpenChange={() => {}} />);

    expect(await screen.findByText('15551234567')).toBeInTheDocument();
    expect(screen.getByText('15559876543')).toBeInTheDocument();
    // First call hits the list endpoint.
    expect(apiFetchMock.mock.calls[0][0]).toBe('/api/dnc');
  });

  it('shows the empty state when no entries', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse({ entries: [] }));

    render(<DncListSheet open onOpenChange={() => {}} />);

    expect(await screen.findByTestId('dnc-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('dnc-entries')).not.toBeInTheDocument();
  });

  it('POSTs a new entry and optimistically prepends it', async () => {
    apiFetchMock
      .mockResolvedValueOnce(jsonResponse({ entries: [] }))
      .mockResolvedValueOnce(jsonResponse({ phone: '15555550100', source: 'manual_settings' }, 201));

    render(<DncListSheet open onOpenChange={() => {}} />);

    await screen.findByTestId('dnc-empty');

    const input = screen.getByTestId('dnc-phone-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '+1 (555) 555-0100' } });
    fireEvent.click(screen.getByTestId('dnc-add-button'));

    expect(await screen.findByText('15555550100')).toBeInTheDocument();
    expect(input.value).toBe('');

    // Second call is the POST.
    expect(apiFetchMock.mock.calls[1][0]).toBe('/api/dnc');
    expect(apiFetchMock.mock.calls[1][1]).toMatchObject({ method: 'POST' });
    const body = JSON.parse(apiFetchMock.mock.calls[1][1].body as string);
    expect(body).toMatchObject({ phone: '+1 (555) 555-0100', source: 'manual_settings' });
  });

  it('DELETEs an entry and removes it from the list', async () => {
    apiFetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          entries: [{ phone: '15551234567', source: 'manual_settings', createdAt: '2026-05-28T17:00:00Z' }],
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    render(<DncListSheet open onOpenChange={() => {}} />);

    await screen.findByText('15551234567');
    fireEvent.click(screen.getByTestId('dnc-remove-15551234567'));

    await waitFor(() => {
      expect(screen.queryByText('15551234567')).not.toBeInTheDocument();
    });

    // The DELETE URL is url-encoded.
    expect(apiFetchMock.mock.calls[1][0]).toBe('/api/dnc/15551234567');
    expect(apiFetchMock.mock.calls[1][1]).toMatchObject({ method: 'DELETE' });
  });

  it('shows an error and keeps the list when POST fails', async () => {
    apiFetchMock
      .mockResolvedValueOnce(jsonResponse({ entries: [] }))
      .mockResolvedValueOnce(jsonResponse({ message: 'Phone number must contain at least 7 digits' }, 400));

    render(<DncListSheet open onOpenChange={() => {}} />);
    await screen.findByTestId('dnc-empty');

    fireEvent.change(screen.getByTestId('dnc-phone-input'), { target: { value: '123' } });
    fireEvent.click(screen.getByTestId('dnc-add-button'));

    expect(await screen.findByText(/at least 7 digits/)).toBeInTheDocument();
    // List is still empty — no optimistic insertion on failure.
    expect(screen.getByTestId('dnc-empty')).toBeInTheDocument();
  });
});
