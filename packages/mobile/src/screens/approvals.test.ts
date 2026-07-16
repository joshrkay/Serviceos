// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PendingProposalSummary } from '../proposals/proposalEvents';

const h = vi.hoisted(() => ({
  back: vi.fn(),
  push: vi.fn(),
  refresh: vi.fn().mockResolvedValue(undefined),
  approveBatch: vi.fn(),
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
vi.mock('../proposals/useApproveBatch', () => ({
  useApproveBatch: () => h.approveBatch,
}));
vi.mock('../components/Toast', () => ({
  useToast: () => ({
    showToast: h.showToast,
    showErrorToast: h.showErrorToast,
    hideToast: vi.fn(),
  }),
}));

// eslint-disable-next-line import/first
import Approvals from '../../app/approvals';

function eligibleProposal(id: string): PendingProposalSummary {
  return {
    id,
    summary: `Draft invoice ${id}`,
    proposalType: 'draft_invoice',
    createdAt: '2026-06-20T00:00:00Z',
    confidenceScore: 0.95,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.proposals = [];
  h.count = 0;
  h.isLoading = false;
  h.error = null;
  h.refresh.mockResolvedValue(undefined);
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
    // The Back control plus one card button.
    expect(container.querySelectorAll('button')).toHaveLength(2);
  });

  it('hides Approve all when fewer than 3 proposals are batch-eligible', () => {
    h.proposals = [
      eligibleProposal('a'),
      eligibleProposal('b'),
      // Money-class / low confidence must not count toward the gate.
      { id: 'c', summary: 'Pay', proposalType: 'record_payment', createdAt: '2026-06-20T00:00:00Z', confidenceScore: 0.99 },
      {
        id: 'd',
        summary: 'Low conf draft',
        proposalType: 'draft_invoice',
        createdAt: '2026-06-20T00:00:00Z',
        confidenceScore: 0.5,
      },
    ];
    h.count = 4;
    const { queryByText } = render(createElement(Approvals));
    expect(queryByText(/Approve all/)).toBeNull();
  });

  it('shows a min-h-11 Approve all (N) button when ≥3 are eligible and batch-approves on tap', async () => {
    h.proposals = [eligibleProposal('a'), eligibleProposal('b'), eligibleProposal('c')];
    h.count = 3;
    h.approveBatch.mockResolvedValue({ approved: ['a', 'b', 'c'], failed: [] });

    const { getByText } = render(createElement(Approvals));
    const button = getByText('Approve all (3)').closest('button')!;
    expect(button.className).toMatch(/\bmin-h-11\b/);

    fireEvent.click(button);
    await waitFor(() => expect(h.approveBatch).toHaveBeenCalledWith(['a', 'b', 'c']));
    expect(h.refresh).toHaveBeenCalled();
    expect(h.showToast).toHaveBeenCalledWith({
      title: 'Approved 3 proposals',
      body: undefined,
      tone: 'info',
    });
  });

  it('toasts a batch-approve failure without refreshing away the error', async () => {
    h.proposals = [eligibleProposal('a'), eligibleProposal('b'), eligibleProposal('c')];
    h.count = 3;
    const failure = new Error('Not allowed');
    h.approveBatch.mockRejectedValue(failure);

    const { getByText } = render(createElement(Approvals));
    fireEvent.click(getByText('Approve all (3)').closest('button')!);
    await waitFor(() => expect(h.showErrorToast).toHaveBeenCalledWith(failure));
    expect(h.refresh).not.toHaveBeenCalled();
  });
});
