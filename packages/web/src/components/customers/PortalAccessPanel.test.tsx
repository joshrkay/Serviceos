import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PortalAccessPanel } from './PortalAccessPanel';

vi.mock('../../utils/api-fetch', () => ({
  apiFetch: vi.fn(),
}));
// Panel actions surface toasts like the rest of CustomerDetail; keep them
// inert so assertions target the rendered panel state.
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { apiFetch } from '../../utils/api-fetch';

const PORTAL_URL = `https://app.example.com/portal/${'a'.repeat(64)}`;

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe('PortalAccessPanel — mint link', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('mints a session via POST /api/portal-sessions and renders the link', async () => {
    vi.mocked(apiFetch).mockResolvedValue(
      jsonResponse(201, {
        id: 'ps-1',
        token: 'a'.repeat(64),
        url: PORTAL_URL,
        expiresAt: '2026-09-04T00:00:00.000Z',
        customerId: '1',
      }),
    );

    render(<PortalAccessPanel customerId="1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Generate portal link' }));

    expect(await screen.findByDisplayValue(PORTAL_URL)).toBeInTheDocument();
    expect(vi.mocked(apiFetch)).toHaveBeenCalledWith('/api/portal-sessions', {
      method: 'POST',
      body: JSON.stringify({ customerId: '1' }),
    });
  });

  it('renders the error state when the mint fails', async () => {
    vi.mocked(apiFetch).mockResolvedValue(
      jsonResponse(503, {
        error: 'NOT_CONFIGURED',
        message: 'Message delivery is not configured for this environment',
      }),
    );

    render(<PortalAccessPanel customerId="1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Generate portal link' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(
      'Message delivery is not configured for this environment',
    );
  });

  it('copies the minted link to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    vi.mocked(apiFetch).mockResolvedValue(
      jsonResponse(201, {
        id: 'ps-1',
        token: 'a'.repeat(64),
        url: PORTAL_URL,
        expiresAt: '2026-09-04T00:00:00.000Z',
        customerId: '1',
      }),
    );

    render(<PortalAccessPanel customerId="1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Generate portal link' }));
    await screen.findByDisplayValue(PORTAL_URL);

    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(PORTAL_URL));
  });
});

describe('PortalAccessPanel — send link', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
  });

  it('sends the link via POST /api/portal-sessions/send with the chosen channel', async () => {
    vi.mocked(apiFetch).mockResolvedValue(
      jsonResponse(202, {
        sessionId: 'ps-2',
        url: PORTAL_URL,
        expiresAt: '2026-09-04T00:00:00.000Z',
        customerId: '1',
        channelsSent: [{ channel: 'email', recipient: 'pat@example.com' }],
      }),
    );

    render(<PortalAccessPanel customerId="1" />);
    fireEvent.change(screen.getByLabelText('Send channel'), {
      target: { value: 'email' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send portal link' }));

    await waitFor(() =>
      expect(vi.mocked(apiFetch)).toHaveBeenCalledWith('/api/portal-sessions/send', {
        method: 'POST',
        body: JSON.stringify({ customerId: '1', channel: 'email' }),
      }),
    );
    expect(
      await screen.findByText(/Portal link sent via email to pat@example\.com/),
    ).toBeInTheDocument();
  });

  it('renders the error state when the send is suppressed', async () => {
    vi.mocked(apiFetch).mockResolvedValue(
      jsonResponse(400, {
        error: 'VALIDATION_ERROR',
        message: 'Portal link send failed on all channels: sms to +15555550100: SMS suppressed: no_consent',
      }),
    );

    render(<PortalAccessPanel customerId="1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Send portal link' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('SMS suppressed: no_consent');
  });
});
