/**
 * D-044 / #1765 — the carrier + mode picker and the codes it shows.
 * Seam: the rendered panel, with the API client stubbed.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const apiFetchMock = vi.fn();
// A stable client: the panel loads in an effect keyed on it.
const client = (...args: unknown[]) => apiFetchMock(...args);
vi.mock('../../../lib/apiClient', () => ({ useApiClient: () => client }));

import { CallForwardingPanel } from './CallForwardingPanel';

function json(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

const RIVET = '+15125550123';
const noCheck = { data: null };
const view = (over: Record<string, unknown> = {}) => ({
  data: { carrier: null, mode: 'missed', checkPassedAt: null, rivetNumber: RIVET, ...over },
});

/** Routes calls by URL so the check endpoint never consumes the setup mocks. */
function route(setup: unknown, check: unknown = noCheck, started: unknown = check) {
  apiFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/forwarding/check')) {
      return init?.method === 'POST' ? json(started, 202) : json(check);
    }
    return json(setup);
  });
}

describe('CallForwardingPanel', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  it('shows no codes until a carrier is picked, and defaults to missed calls only', async () => {
    route(view());
    render(<CallForwardingPanel />);
    await screen.findByText('Forward your calls to Rivet');
    expect(screen.queryByTestId('call-forwarding-codes')).toBeNull();
    expect(screen.getByRole('button', { name: /Missed calls only/ })).toHaveAttribute('aria-pressed', 'true');
  });

  it('saves the carrier and shows the dial code, a tap-to-dial link and the off code', async () => {
    let current = view();
    apiFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/forwarding/check')) return json(noCheck);
      if (init?.method === 'PUT') current = view({ carrier: 'att' });
      return json(current);
    });
    render(<CallForwardingPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'AT&T' }));

    const codes = await screen.findByTestId('call-forwarding-codes');
    expect(codes).toHaveTextContent('**61*5125550123#');
    expect(codes).toHaveTextContent('##61#');
    const links = codes.querySelectorAll('a');
    expect(links[0]).toHaveAttribute('href', 'tel:**61*5125550123%23');
    expect(apiFetchMock).toHaveBeenCalledWith(
      '/api/get-found-online/forwarding',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ carrier: 'att', mode: 'missed' }) }),
    );
  });

  it('switching to all calls re-saves with the chosen carrier and shows that mode code', async () => {
    let current = view({ carrier: 'verizon' });
    apiFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/forwarding/check')) return json(noCheck);
      if (init?.method === 'PUT') current = view({ carrier: 'verizon', mode: 'all' });
      return json(current);
    });
    render(<CallForwardingPanel />);
    fireEvent.click(await screen.findByRole('button', { name: /All calls/ }));
    await waitFor(() => expect(screen.getByTestId('call-forwarding-codes')).toHaveTextContent('*725125550123'));
    expect(apiFetchMock).toHaveBeenCalledWith(
      '/api/get-found-online/forwarding',
      expect.objectContaining({ body: JSON.stringify({ carrier: 'verizon', mode: 'all' }) }),
    );
  });

  it('gives generic instructions for Other', async () => {
    route(view({ carrier: 'other' }));
    render(<CallForwardingPanel />);
    const generic = await screen.findByTestId('call-forwarding-generic');
    expect(generic).toHaveTextContent('no-answer and busy call forwarding');
    expect(generic).toHaveTextContent(RIVET);
    expect(screen.queryByTestId('call-forwarding-codes')).toBeNull();
  });

  it('says when the Rivet number is not ready instead of showing a broken code', async () => {
    route(view({ carrier: 'verizon', rivetNumber: null }));
    render(<CallForwardingPanel />);
    expect(await screen.findByRole('status')).toHaveTextContent("isn't ready yet");
    expect(screen.queryByTestId('call-forwarding-codes')).toBeNull();
  });

  it('shows a save failure', async () => {
    apiFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/forwarding/check')) return json(noCheck);
      return init?.method === 'PUT' ? json({}, 500) : json(view());
    });
    render(<CallForwardingPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Verizon' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't save");
  });

  it('keeps every control and link at least 44px tall (min-h-11)', async () => {
    route(view({ carrier: 'tmobile' }));
    render(<CallForwardingPanel />);
    await screen.findByTestId('call-forwarding-codes');
    for (const el of [...screen.getAllByRole('button'), ...screen.getAllByRole('link')]) {
      expect(el.className).toContain('min-h-11');
    }
  });

  it('Test it starts a check and shows the let-it-ring guidance', async () => {
    const pending = {
      data: {
        status: 'pending',
        checkedAt: null,
        expiresAt: '2026-10-22T12:02:00Z',
        guidance: 'Calling your business phone now. Let it ring out.',
      },
    };
    route(view({ carrier: 'verizon' }), noCheck, pending);
    render(<CallForwardingPanel />);
    const button = await screen.findByRole('button', { name: 'Test it' });
    expect(button.className).toContain('min-h-11');
    fireEvent.click(button);
    expect(await screen.findByTestId('call-forwarding-check-result')).toHaveTextContent('Let it ring out');
    expect(apiFetchMock).toHaveBeenCalledWith('/api/get-found-online/forwarding/check', { method: 'POST' });
  });

  it('shows the last passing date with a re-check, and plain guidance when a test timed out', async () => {
    const timedOut = {
      data: {
        status: 'timed_out',
        checkedAt: null,
        expiresAt: null,
        guidance: 'The test call did not come back. Make sure you let your phone ring out.',
      },
    };
    route(view({ carrier: 'att', checkPassedAt: '2026-10-20T15:00:00.000Z' }), timedOut);
    render(<CallForwardingPanel />);
    expect(await screen.findByText(/Last passing test:/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Test again' })).toBeInTheDocument();
    expect(await screen.findByTestId('call-forwarding-check-result')).toHaveAttribute('data-status', 'timed_out');
  });

  it('says so when the test cannot start (rate limited)', async () => {
    apiFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/forwarding/check')) {
        return init?.method === 'POST' ? json({ message: 'x' }, 429) : json(noCheck);
      }
      return json(view({ carrier: 'verizon' }));
    });
    render(<CallForwardingPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Test it' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many tests');
  });
});
