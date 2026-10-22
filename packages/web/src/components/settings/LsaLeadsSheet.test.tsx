import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const apiFetchMock = vi.fn();
vi.mock('../../utils/api-fetch', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { LsaLeadsSheet } from './LsaLeadsSheet';

function json(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

const linked = {
  enabled: true,
  autoRespond: false,
  secretHint: 'ab12',
  accountId: null,
  webhookUrl: 'https://api.example.com/webhooks/lsa/t1',
  recentLeads: [
    { leadId: 'l1', name: 'Jane Doe', stage: 'new', leadType: 'message', receivedAt: '2026-10-01T10:00:00Z', speedToLead: null, disposition: null },
  ],
};

describe('LsaLeadsSheet', () => {
  beforeEach(() => apiFetchMock.mockReset());

  it('shows the not-linked state and links, showing the secret once', async () => {
    apiFetchMock
      .mockResolvedValueOnce(json({ data: null }))
      .mockResolvedValueOnce(json({ data: { ...linked, webhookSecret: 'lsa_secret_ab12' } }, true, 201))
      .mockResolvedValueOnce(json({ data: linked }));
    render(<LsaLeadsSheet onClose={() => {}} />);
    await screen.findByTestId('lsa-not-linked');
    fireEvent.click(screen.getByTestId('lsa-link'));
    expect(await screen.findByTestId('lsa-new-secret')).toHaveTextContent('lsa_secret_ab12');
    expect(screen.getByTestId('lsa-linked')).toHaveTextContent('https://api.example.com/webhooks/lsa/t1');
  });

  it('lists recent LSA leads and toggles the text-back opt-in', async () => {
    apiFetchMock
      .mockResolvedValueOnce(json({ data: linked }))
      .mockResolvedValueOnce(json({ data: { ...linked, autoRespond: true } }))
      .mockResolvedValueOnce(json({ data: { ...linked, autoRespond: true } }));
    render(<LsaLeadsSheet onClose={() => {}} />);
    expect(await screen.findByText('Jane Doe')).toBeInTheDocument();
    const box = screen.getByTestId('lsa-auto-respond') as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith(
        '/api/lsa-integration',
        expect.objectContaining({ method: 'PUT', body: JSON.stringify({ autoRespond: true }) }),
      ),
    );
  });

  it('unlinks', async () => {
    apiFetchMock.mockResolvedValueOnce(json({ data: linked })).mockResolvedValueOnce(json({ unlinked: true }));
    render(<LsaLeadsSheet onClose={() => {}} />);
    fireEvent.click(await screen.findByTestId('lsa-unlink'));
    await screen.findByTestId('lsa-not-linked');
  });

  it('keeps every control at a 44px tap target and wraps long values (320px contract)', async () => {
    apiFetchMock.mockResolvedValueOnce(json({ data: linked }));
    render(<LsaLeadsSheet onClose={() => {}} />);
    await screen.findByTestId('lsa-linked');
    expect(screen.getByTestId('lsa-unlink').className).toContain('min-h-11');
    expect(screen.getByTestId('lsa-rotate').className).toContain('min-h-11');
    expect(screen.getByLabelText('Close').className).toContain('size-11');
    expect(screen.getByTestId('lsa-auto-respond').closest('label')!.className).toContain('min-h-11');
    expect(screen.getByTestId('lsa-linked').textContent).toBeTruthy();
    expect(screen.getByTestId('lsa-linked').querySelector('.break-all')).not.toBeNull();
  });

  it('surfaces an API error', async () => {
    apiFetchMock.mockResolvedValueOnce(json({ message: 'nope' }, false, 403));
    render(<LsaLeadsSheet onClose={() => {}} />);
    expect(await screen.findByTestId('lsa-error')).toHaveTextContent('nope');
  });
});
