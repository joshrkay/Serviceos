// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PendingProposalSummary } from '../proposals/proposalEvents';

const h = vi.hoisted(() => ({
  back: vi.fn(),
  push: vi.fn(),
  refresh: vi.fn(),
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

// eslint-disable-next-line import/first
import Approvals from '../../app/approvals';

beforeEach(() => {
  vi.clearAllMocks();
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
    // The Back control plus one card button.
    expect(container.querySelectorAll('button')).toHaveLength(2);
  });
});
