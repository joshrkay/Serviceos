// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PendingProposalSummary } from '../proposals/proposalEvents';

const h = vi.hoisted(() => ({
  back: vi.fn(),
  push: vi.fn(),
  refresh: vi.fn(),
  approveBatch: vi.fn().mockResolvedValue({ approved: [], failed: [] }),
  showToast: vi.fn(),
  showErrorToast: vi.fn(),
  proposals: [] as PendingProposalSummary[],
  count: 0,
  isLoading: false,
  error: null as string | null,
}));

vi.mock('expo-router', () => ({
  useRouter: () => ({ back: h.back, push: h.push, replace: vi.fn() }),
}));
vi.mock('../hooks/usePendingProposals', () => ({
  usePendingProposals: () => ({
    proposals: h.proposals,
    count: h.count,
    isLoading: h.isLoading,
    error: h.error,
    refresh: h.refresh,
  }),
}));
vi.mock('../proposals/useApproveBatch', () => ({ useApproveBatch: () => h.approveBatch }));
vi.mock('../components/Toast', () => ({
  useToast: () => ({ showToast: h.showToast, showErrorToast: h.showErrorToast, hideToast: vi.fn() }),
}));

// eslint-disable-next-line import/first
import Approvals from '../../app/approvals';

const elig = (id: string): PendingProposalSummary => ({
  id,
  summary: `Invoice ${id}`,
  proposalType: 'draft_invoice', // capture-class
  createdAt: '2026-06-20T00:00:00Z',
  confidenceScore: 0.95, // high
});

beforeEach(() => {
  vi.clearAllMocks();
  h.approveBatch = vi.fn().mockResolvedValue({ approved: [], failed: [] });
  h.proposals = [];
  h.count = 0;
  h.isLoading = false;
  h.error = null;
});

afterEach(() => cleanup());

describe('Approvals screen', () => {
  it('Back is a >=44px tap target and returns to the prior screen', () => {
    const { getByText } = render(createElement(Approvals));
    const back = getByText('‹ Back').closest('button')!;
    expect(back.className).toMatch(/\bmin-h-11\b/);
    fireEvent.click(back);
    expect(h.back).toHaveBeenCalledTimes(1);
  });

  it('shows the empty state when nothing is waiting', () => {
    const { getByText } = render(createElement(Approvals));
    expect(getByText('Nothing waiting')).toBeTruthy();
    expect(getByText(/your drafts will appear here/i)).toBeTruthy();
  });

  it('renders the live count and one card per pending proposal', () => {
    h.proposals = [
      { id: 'a', summary: 'Invoice #12 for Acme', proposalType: 'draft_invoice', createdAt: '2026-06-20T00:00:00Z' },
      { id: 'b', summary: 'Record $200 payment', proposalType: 'record_payment', createdAt: '2026-06-20T00:00:00Z' },
    ];
    h.count = 2;
    const { getByText } = render(createElement(Approvals));
    expect(getByText('2 waiting for you')).toBeTruthy();
    expect(getByText('Invoice #12 for Acme')).toBeTruthy();
    expect(getByText('Record $200 payment')).toBeTruthy();
    // Friendly type labels, not raw enum values.
    expect(getByText('Invoice')).toBeTruthy();
    expect(getByText('Payment')).toBeTruthy();
  });

  it('badges each card with its confidence band and time-to-expiry', () => {
    h.proposals = [
      {
        id: 'a',
        summary: 'Invoice #12 for Acme',
        proposalType: 'draft_invoice',
        createdAt: '2026-06-20T00:00:00Z',
        confidenceScore: 0.92,
        expiresAt: new Date(Date.now() + 5 * 3_600_000).toISOString(),
      },
      {
        id: 'b',
        summary: 'Record $200 payment',
        proposalType: 'record_payment',
        createdAt: '2026-06-20T00:00:00Z',
        confidenceScore: 0.45,
      },
    ];
    h.count = 2;
    const { getByText, getAllByText } = render(createElement(Approvals));
    expect(getByText('High')).toBeTruthy(); // 0.92 → high
    expect(getByText('Low')).toBeTruthy(); // 0.45 → low
    // The first card carries a "<n>h" countdown; the second (no expiry) does not.
    expect(getAllByText(/^\d+h$/).length).toBe(1);
  });

  it('omits the confidence badge when a proposal has no score', () => {
    h.proposals = [
      { id: 'a', summary: 'No score', proposalType: 'add_note', createdAt: '2026-06-20T00:00:00Z' },
    ];
    h.count = 1;
    const { queryByText } = render(createElement(Approvals));
    expect(queryByText('High')).toBeNull();
    expect(queryByText('Medium')).toBeNull();
    expect(queryByText('Low')).toBeNull();
  });

  it('opens the review screen when a proposal card is tapped', () => {
    h.proposals = [
      { id: 'prop-1', summary: 'Invoice #12 for Acme', proposalType: 'draft_invoice', createdAt: '2026-06-20T00:00:00Z' },
    ];
    h.count = 1;
    const { getByText, container } = render(createElement(Approvals));
    const card = getByText('Invoice #12 for Acme').closest('button')!;
    expect(card.className).toMatch(/\bmin-h-11\b/);
    fireEvent.click(card);
    expect(h.push).toHaveBeenCalledWith('/proposals/prop-1');
    // No eligible bar for an unscored proposal: Back + one card button only.
    expect(container.querySelectorAll('button')).toHaveLength(2);
  });

  it('offers one-tap "Approve all" only for high-confidence capture proposals', () => {
    // One eligible (capture + high) and one excluded (money, even at high conf).
    h.proposals = [
      elig('elig'),
      { id: 'money', summary: 'Record $500', proposalType: 'record_payment', createdAt: '2026-06-20T00:00:00Z', confidenceScore: 0.99 },
    ];
    h.count = 2;
    const { getByText } = render(createElement(Approvals));
    expect(getByText('1 high-confidence eligible for one-tap approval')).toBeTruthy();
    fireEvent.click(getByText('Approve all').closest('button')!);
    expect(getByText('Approve 1 high-confidence?')).toBeTruthy();
  });

  it('batch-approves only the eligible ids, toasts the result, and refreshes', async () => {
    h.approveBatch = vi.fn().mockResolvedValue({ approved: ['elig'], failed: [] });
    h.proposals = [
      elig('elig'),
      { id: 'money', summary: 'Record $500', proposalType: 'record_payment', createdAt: '2026-06-20T00:00:00Z', confidenceScore: 0.99 },
    ];
    h.count = 2;
    const { getByText } = render(createElement(Approvals));
    fireEvent.click(getByText('Approve all').closest('button')!);
    fireEvent.click(getByText('Approve 1 eligible').closest('button')!);

    await waitFor(() => expect(h.approveBatch).toHaveBeenCalledWith(['elig']));
    await waitFor(() => expect(h.showToast).toHaveBeenCalled());
    expect(h.refresh).toHaveBeenCalled();
    // The money-class proposal was never in the batch.
    expect(h.approveBatch.mock.calls[0][0]).not.toContain('money');
  });

  it('reports partial batch failures in the toast body', async () => {
    h.approveBatch = vi.fn().mockResolvedValue({
      approved: ['elig'],
      failed: [{ id: 'elig2', reason: 'VALIDATION_ERROR' }],
    });
    h.proposals = [elig('elig'), elig('elig2')];
    h.count = 2;
    const { getByText } = render(createElement(Approvals));
    fireEvent.click(getByText('Approve all').closest('button')!);
    fireEvent.click(getByText('Approve 2 eligible').closest('button')!);
    await waitFor(() =>
      expect(h.showToast).toHaveBeenCalledWith(
        expect.objectContaining({ body: expect.stringMatching(/couldn.t be approved/i) }),
      ),
    );
  });

  it('flips the toast to "No proposals approved" (error) when the whole batch fails', async () => {
    h.approveBatch = vi.fn().mockResolvedValue({
      approved: [],
      failed: [{ id: 'elig', reason: 'VALIDATION_ERROR' }],
    });
    h.proposals = [elig('elig')];
    h.count = 1;
    const { getByText } = render(createElement(Approvals));
    fireEvent.click(getByText('Approve all').closest('button')!);
    fireEvent.click(getByText('Approve 1 eligible').closest('button')!);
    await waitFor(() =>
      expect(h.showToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'No proposals approved', tone: 'error' }),
      ),
    );
  });

  it('keeps the sheet open and surfaces an error when the batch call fails', async () => {
    h.approveBatch = vi.fn().mockRejectedValue(new Error('HTTP 500'));
    h.proposals = [elig('elig')];
    h.count = 1;
    const { getByText } = render(createElement(Approvals));
    fireEvent.click(getByText('Approve all').closest('button')!);
    fireEvent.click(getByText('Approve 1 eligible').closest('button')!);
    await waitFor(() => expect(h.showErrorToast).toHaveBeenCalled());
    expect(h.refresh).not.toHaveBeenCalled();
    // Sheet is still open for a retry.
    expect(getByText('Approve 1 high-confidence?')).toBeTruthy();
  });

  it('hides the Approve-all bar when nothing is eligible', () => {
    h.proposals = [
      { id: 'low', summary: 'Low conf', proposalType: 'draft_invoice', createdAt: '2026-06-20T00:00:00Z', confidenceScore: 0.5 },
    ];
    h.count = 1;
    const { queryByText } = render(createElement(Approvals));
    expect(queryByText(/eligible for one-tap/)).toBeNull();
  });
});
