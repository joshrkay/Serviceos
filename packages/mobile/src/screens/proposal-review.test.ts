// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReviewPhase } from '../hooks/useProposalReview';

const h = vi.hoisted(() => ({
  approve: vi.fn(),
  undo: vi.fn(),
  reload: vi.fn(),
  back: vi.fn(),
  phase: 'review' as ReviewPhase,
  secondsLeft: 0,
  error: null as string | null,
  proposal: {
    id: 'p1',
    proposalType: 'draft_invoice',
    status: 'ready_for_review',
    summary: 'Invoice Acme $123.45',
    explanation: 'Grounded in the catalog.',
    confidenceScore: 0.9,
    payload: { customerName: 'Acme', amountCents: 12345 },
    approvedAt: null as string | null,
  } as unknown,
}));

vi.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ id: 'p1' }),
  useRouter: () => ({ back: h.back, push: vi.fn(), replace: vi.fn() }),
}));
vi.mock('../hooks/useProposalReview', () => ({
  useProposalReview: () => ({
    proposal: h.proposal,
    phase: h.phase,
    error: h.error,
    secondsLeft: h.secondsLeft,
    approve: h.approve,
    undo: h.undo,
    reload: h.reload,
  }),
}));

// eslint-disable-next-line import/first
import ProposalReviewScreen from '../../app/proposals/[id]';

beforeEach(() => {
  vi.clearAllMocks();
  h.phase = 'review';
  h.secondsLeft = 0;
  h.error = null;
});

afterEach(() => cleanup());

describe('Proposal review screen', () => {
  it('shows the draft + a >=44px Approve target and approves on tap', () => {
    const { getByText } = render(createElement(ProposalReviewScreen));
    expect(getByText('Invoice Acme $123.45')).toBeTruthy();
    expect(getByText('Invoice')).toBeTruthy(); // friendly type label
    expect(getByText('Amount Cents')).toBeTruthy(); // payload row…
    expect(getByText('$123.45')).toBeTruthy(); // …with cents rendered as dollars
    const approve = getByText('Approve').closest('button')!;
    expect(approve.className).toMatch(/\bmin-h-11\b/);
    fireEvent.click(approve);
    expect(h.approve).toHaveBeenCalledTimes(1);
  });

  it('shows the undo countdown and undoes on tap while approved', () => {
    h.phase = 'approved';
    h.secondsLeft = 4;
    const { getByText } = render(createElement(ProposalReviewScreen));
    expect(getByText('Running in 4s — tap undo to stop.')).toBeTruthy();
    const undo = getByText('Undo (4)').closest('button')!;
    expect(undo.className).toMatch(/\bmin-h-11\b/);
    fireEvent.click(undo);
    expect(h.undo).toHaveBeenCalledTimes(1);
  });

  it('confirms the approval once the window has committed', () => {
    h.phase = 'committed';
    const { getByText } = render(createElement(ProposalReviewScreen));
    expect(getByText(/run it and let you know/i)).toBeTruthy();
    fireEvent.click(getByText('Back to approvals').closest('button')!);
    expect(h.back).toHaveBeenCalledTimes(1);
  });

  it('confirms nothing executed after an undo', () => {
    h.phase = 'undone';
    const { getByText } = render(createElement(ProposalReviewScreen));
    expect(getByText('✓ Undone')).toBeTruthy();
    expect(getByText(/Nothing was executed/i)).toBeTruthy();
  });

  it('surfaces a load error with a retry', () => {
    h.phase = 'error';
    h.error = 'HTTP 500';
    const { getByText } = render(createElement(ProposalReviewScreen));
    expect(getByText('HTTP 500')).toBeTruthy();
    fireEvent.click(getByText('Try again').closest('button')!);
    expect(h.reload).toHaveBeenCalledTimes(1);
  });
});
