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
const view = (over: Record<string, unknown> = {}) => ({
  data: { carrier: null, mode: 'missed', checkPassedAt: null, rivetNumber: RIVET, ...over },
});

describe('CallForwardingPanel', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  it('shows no codes until a carrier is picked, and defaults to missed calls only', async () => {
    apiFetchMock.mockResolvedValue(json(view()));
    render(<CallForwardingPanel />);
    await screen.findByText('Forward your calls to Rivet');
    expect(screen.queryByTestId('call-forwarding-codes')).toBeNull();
    expect(screen.getByRole('button', { name: /Missed calls only/ })).toHaveAttribute('aria-pressed', 'true');
  });

  it('saves the carrier and shows the dial code, a tap-to-dial link and the off code', async () => {
    apiFetchMock
      .mockResolvedValueOnce(json(view()))
      .mockResolvedValueOnce(json(view({ carrier: 'att' })));
    render(<CallForwardingPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'AT&T' }));

    const codes = await screen.findByTestId('call-forwarding-codes');
    expect(codes).toHaveTextContent('**61*5125550123#');
    expect(codes).toHaveTextContent('##61#');
    const links = codes.querySelectorAll('a');
    expect(links[0]).toHaveAttribute('href', 'tel:**61*5125550123%23');
    expect(apiFetchMock).toHaveBeenLastCalledWith(
      '/api/get-found-online/forwarding',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ carrier: 'att', mode: 'missed' }) }),
    );
  });

  it('switching to all calls re-saves with the chosen carrier and shows that mode code', async () => {
    apiFetchMock
      .mockResolvedValueOnce(json(view({ carrier: 'verizon' })))
      .mockResolvedValueOnce(json(view({ carrier: 'verizon', mode: 'all' })));
    render(<CallForwardingPanel />);
    fireEvent.click(await screen.findByRole('button', { name: /All calls/ }));
    await waitFor(() => expect(screen.getByTestId('call-forwarding-codes')).toHaveTextContent('*725125550123'));
    expect(apiFetchMock).toHaveBeenLastCalledWith(
      '/api/get-found-online/forwarding',
      expect.objectContaining({ body: JSON.stringify({ carrier: 'verizon', mode: 'all' }) }),
    );
  });

  it('gives generic instructions for Other', async () => {
    apiFetchMock.mockResolvedValue(json(view({ carrier: 'other' })));
    render(<CallForwardingPanel />);
    const generic = await screen.findByTestId('call-forwarding-generic');
    expect(generic).toHaveTextContent('no-answer and busy call forwarding');
    expect(generic).toHaveTextContent(RIVET);
    expect(screen.queryByTestId('call-forwarding-codes')).toBeNull();
  });

  it('says when the Rivet number is not ready instead of showing a broken code', async () => {
    apiFetchMock.mockResolvedValue(json(view({ carrier: 'verizon', rivetNumber: null })));
    render(<CallForwardingPanel />);
    expect(await screen.findByRole('status')).toHaveTextContent("isn't ready yet");
    expect(screen.queryByTestId('call-forwarding-codes')).toBeNull();
  });

  it('shows a save failure', async () => {
    apiFetchMock.mockResolvedValueOnce(json(view())).mockResolvedValueOnce(json({}, 500));
    render(<CallForwardingPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Verizon' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't save");
  });

  it('keeps every control and link at least 44px tall (min-h-11)', async () => {
    apiFetchMock.mockResolvedValue(json(view({ carrier: 'tmobile' })));
    render(<CallForwardingPanel />);
    await screen.findByTestId('call-forwarding-codes');
    for (const el of [...screen.getAllByRole('button'), ...screen.getAllByRole('link')]) {
      expect(el.className).toContain('min-h-11');
    }
  });
});
