import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { InboxPage } from './InboxPage';

const apiFetch = vi.fn();
vi.mock('../../lib/apiClient', () => ({
  useApiClient: () => apiFetch,
}));

function jsonResponse(body: unknown, init: ResponseInit = { status: 200 }): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

describe('InboxPage', () => {
  beforeEach(() => apiFetch.mockReset());

  it('renders the prioritized proposals sorted by urgency', async () => {
    apiFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          {
            proposal: { id: 'p-crit', proposalType: 'create_booking', summary: 'Hold expires in 30 min', status: 'ready_for_review', createdAt: new Date().toISOString() },
            urgency: 'critical',
            reason: 'Expiring within 2 hours',
          },
          {
            proposal: { id: 'p-norm', proposalType: 'draft_invoice', summary: 'Invoice for the Johnson job', status: 'ready_for_review', createdAt: new Date().toISOString() },
            urgency: 'normal',
            reason: 'Awaiting review',
          },
        ],
        summary: { totalCount: 2, criticalCount: 1, highCount: 0, normalCount: 1, lowCount: 0, truncated: false },
      }),
    );

    render(<InboxPage />);

    await waitFor(() => {
      expect(screen.getByText('Hold expires in 30 min')).toBeInTheDocument();
      expect(screen.getByText('Invoice for the Johnson job')).toBeInTheDocument();
    });
    const rows = screen.getAllByTestId('inbox-row');
    expect(rows[0]).toHaveTextContent('Hold expires in 30 min');
    expect(rows[1]).toHaveTextContent('Invoice for the Johnson job');
    expect(screen.getByText(/critical/i)).toBeInTheDocument();
  });

  it('shows an empty-state when there are zero proposals', async () => {
    apiFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [],
        summary: { totalCount: 0, criticalCount: 0, highCount: 0, normalCount: 0, lowCount: 0, truncated: false },
      }),
    );
    render(<InboxPage />);
    await waitFor(() => {
      expect(screen.getByText(/nothing waiting/i)).toBeInTheDocument();
    });
  });

  it('approves a proposal and removes it from the list optimistically', async () => {
    apiFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          { proposal: { id: 'p-1', proposalType: 'add_note', summary: 'Add a note', status: 'ready_for_review', createdAt: new Date().toISOString() }, urgency: 'low', reason: 'Standard priority' },
        ],
        summary: { totalCount: 1, criticalCount: 0, highCount: 0, normalCount: 0, lowCount: 1, truncated: false },
      }),
    );
    apiFetch.mockResolvedValueOnce(jsonResponse({ data: { id: 'p-1', status: 'approved' } }));

    render(<InboxPage />);
    await waitFor(() => screen.getByText('Add a note'));
    fireEvent.click(screen.getByRole('button', { name: /approve/i }));

    await waitFor(() => {
      expect(screen.queryByText('Add a note')).not.toBeInTheDocument();
    });
    expect(apiFetch).toHaveBeenCalledWith(
      '/api/proposals/p-1/approve',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('rejects a proposal and removes it from the list', async () => {
    apiFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          { proposal: { id: 'p-2', proposalType: 'add_note', summary: 'Add another note', status: 'ready_for_review', createdAt: new Date().toISOString() }, urgency: 'low', reason: 'Standard priority' },
        ],
        summary: { totalCount: 1, criticalCount: 0, highCount: 0, normalCount: 0, lowCount: 1, truncated: false },
      }),
    );
    apiFetch.mockResolvedValueOnce(jsonResponse({ data: { id: 'p-2', status: 'rejected' } }));

    render(<InboxPage />);
    await waitFor(() => screen.getByText('Add another note'));
    fireEvent.click(screen.getByRole('button', { name: /reject/i }));

    await waitFor(() => {
      expect(screen.queryByText('Add another note')).not.toBeInTheDocument();
    });
    expect(apiFetch).toHaveBeenCalledWith(
      '/api/proposals/p-2/reject',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});
