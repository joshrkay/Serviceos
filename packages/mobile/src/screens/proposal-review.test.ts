// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReviewPhase } from '../hooks/useProposalReview';

const h = vi.hoisted(() => ({
  approve: vi.fn(),
  reject: vi.fn().mockResolvedValue(undefined),
  resolveLine: vi.fn().mockResolvedValue(undefined),
  resolveEntity: vi.fn().mockResolvedValue(undefined),
  edit: vi.fn().mockResolvedValue(true),
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
  usePathname: () => '/proposals/p1',
}));
// ProposalEditPanel renders LineItemSheet, whose catalog search runs through
// the real api client hook — stub it so edit-mode renders don't need auth.
vi.mock('../lib/useApiClient', () => ({
  useApiClient: () => vi.fn().mockResolvedValue({ ok: true, json: async () => ({ items: [] }) }),
}));
vi.mock('../hooks/useProposalReview', () => ({
  useProposalReview: () => ({
    proposal: h.proposal,
    phase: h.phase,
    error: h.error,
    secondsLeft: h.secondsLeft,
    approve: h.approve,
    reject: h.reject,
    resolveLine: h.resolveLine,
    resolveEntity: h.resolveEntity,
    edit: h.edit,
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

  it('shows a reject form and calls reject with the entered reason', () => {
    const { getByText, getByPlaceholderText, getAllByText } = render(
      createElement(ProposalReviewScreen),
    );
    fireEvent.click(getByText('Reject').closest('button')!);
    fireEvent.change(getByPlaceholderText('Tell the AI what was wrong'), {
      target: { value: 'Wrong customer' },
    });
    const confirmButtons = getAllByText('Reject').map((node) => node.closest('button')!);
    fireEvent.click(confirmButtons[confirmButtons.length - 1]!);
    expect(h.reject).toHaveBeenCalledWith('Wrong customer');
  });

  it('renders entity ClarifyPicker chips for voice_clarification proposals', () => {
    h.proposal = {
      id: 'p-clarify',
      proposalType: 'voice_clarification',
      status: 'draft',
      summary: 'Which Bob?',
      payload: {
        reason: 'ambiguous_entity',
        entityCandidates: [
          { id: 'c1', label: 'Bob Smith', hint: '555-0100' },
          { id: 'c2', label: 'Bob Jones' },
        ],
      },
      approvedAt: null,
    };
    const { getByText, queryByText } = render(createElement(ProposalReviewScreen));
    expect(getByText('Which one did you mean?')).toBeTruthy();
    expect(getByText('Bob Smith')).toBeTruthy();
    expect(queryByText('Approve')).toBeNull();
    fireEvent.click(getByText('Bob Smith').closest('button')!);
    // U8 (E9) — picking a candidate re-drafts the original action via
    // resolveEntity instead of discarding it through reject('entity_selected').
    expect(h.resolveEntity).toHaveBeenCalledWith('c1');
    expect(h.reject).not.toHaveBeenCalled();
  });

  it('renders catalog resolve-line picker for ambiguous line items', () => {
    h.proposal = {
      id: 'p-est',
      proposalType: 'draft_estimate',
      status: 'draft',
      summary: 'Estimate flush valve',
      payload: {
        lineItems: [{ description: 'Flush valve', pricingSource: 'ambiguous' }],
      },
      sourceContext: {
        catalogResolution: {
          '0': [{ id: 'cat-b', name: 'Premium valve', unitPriceCents: 8200, score: 0.6 }],
        },
      },
      approvedAt: null,
    };
    const { getByText } = render(createElement(ProposalReviewScreen));
    expect(getByText(/Which item for "Flush valve"/)).toBeTruthy();
    expect(getByText('Premium valve')).toBeTruthy();
    fireEvent.click(getByText('Premium valve').closest('button')!);
    expect(h.resolveLine).toHaveBeenCalledWith(0, 'cat-b');
  });

  // U1 — lane-aware confirm gates. Capture one-taps (covered by the first
  // test); money/comms/irreversible/unknown require an explicit confirm.
  function setProposal(proposalType: string, summary = 'Summary line') {
    h.proposal = {
      id: 'p-gate',
      proposalType,
      status: 'ready_for_review',
      summary,
      payload: {},
      approvedAt: null,
    };
  }

  it('money lane: Approve opens a confirm sheet; Confirm approves', () => {
    setProposal('issue_invoice', 'Issue INV-42 for $1,240');
    const { getByText } = render(createElement(ProposalReviewScreen));
    fireEvent.click(getByText('Approve').closest('button')!);
    expect(h.approve).not.toHaveBeenCalled();
    expect(getByText('Issue invoice — this moves money.')).toBeTruthy();
    const confirm = getByText('Confirm').closest('button')!;
    expect(confirm.className).toMatch(/\bmin-h-11\b/);
    fireEvent.click(confirm);
    expect(h.approve).toHaveBeenCalledTimes(1);
  });

  it('comms lane: Cancel dismisses the sheet without approving', () => {
    setProposal('send_invoice', 'Send invoice to Rodriguez');
    const { getByText, queryByText } = render(createElement(ProposalReviewScreen));
    fireEvent.click(getByText('Approve').closest('button')!);
    expect(getByText('Send invoice — this messages your customer.')).toBeTruthy();
    const cancel = getByText('Cancel').closest('button')!;
    expect(cancel.className).toMatch(/\bmin-h-11\b/);
    fireEvent.click(cancel);
    expect(h.approve).not.toHaveBeenCalled();
    expect(queryByText('Send invoice — this messages your customer.')).toBeNull();
    expect(getByText('Approve')).toBeTruthy(); // main button is back
  });

  it('irreversible lane: destructive confirm styling', () => {
    setProposal('cancel_appointment', 'Cancel Tuesday visit');
    const { getByText } = render(createElement(ProposalReviewScreen));
    fireEvent.click(getByText('Approve').closest('button')!);
    expect(getByText(/can't be undone/)).toBeTruthy();
    const confirm = getByText('Yes, do it').closest('button')!;
    expect(confirm.className).toMatch(/\bbg-destructive\b/);
    fireEvent.click(confirm);
    expect(h.approve).toHaveBeenCalledTimes(1);
  });

  it('unknown proposal type fails closed to an explicit confirm — never one-tap', () => {
    setProposal('some_future_type', 'Mystery action');
    const { getByText } = render(createElement(ProposalReviewScreen));
    fireEvent.click(getByText('Approve').closest('button')!);
    expect(h.approve).not.toHaveBeenCalled();
    expect(getByText(/review carefully before approving/)).toBeTruthy();
  });

  // U2 (F4) — edit before approving.
  it('Edit opens the panel; editing a cents field saves parsed integer cents', async () => {
    h.proposal = {
      id: 'p-edit',
      proposalType: 'draft_invoice',
      status: 'draft',
      summary: 'Invoice Acme',
      payload: { customerName: 'Acme', amountCents: 12345 },
      approvedAt: null,
    };
    const { getByText, getByDisplayValue, findByText } = render(
      createElement(ProposalReviewScreen),
    );
    const editBtn = getByText('Edit').closest('button')!;
    expect(editBtn.className).toMatch(/\bmin-h-11\b/);
    fireEvent.click(editBtn);
    expect(getByText('Edit before approving')).toBeTruthy();

    // The cents field renders as bare dollars ("123.45") ready to edit.
    fireEvent.change(getByDisplayValue('123.45'), { target: { value: '$1,299.50' } });
    fireEvent.click(getByText('Save').closest('button')!);
    await findByText('Edit'); // panel closes back to the action row
    expect(h.edit).toHaveBeenCalledWith({ amountCents: 129950 });
  });

  it('Cancel leaves edit mode without saving; no-op save just closes', () => {
    setProposal('draft_invoice', 'Invoice Acme');
    const { getByText, queryByText } = render(createElement(ProposalReviewScreen));
    fireEvent.click(getByText('Edit').closest('button')!);
    fireEvent.click(getByText('Cancel').closest('button')!);
    expect(h.edit).not.toHaveBeenCalled();
    expect(queryByText('Edit before approving')).toBeNull();
  });

  it('line-item payloads offer the grounded editor (remove + add from price book)', () => {
    h.proposal = {
      id: 'p-li',
      proposalType: 'draft_estimate',
      status: 'draft',
      summary: 'Estimate heater',
      payload: {
        lineItems: [
          { catalogItemId: 'c1', description: 'Heater', quantity: 1, unitPriceCents: 72000 },
        ],
      },
      approvedAt: null,
    };
    const { getByText } = render(createElement(ProposalReviewScreen));
    fireEvent.click(getByText('Edit').closest('button')!);
    expect(getByText('Heater')).toBeTruthy();
    expect(getByText('Remove')).toBeTruthy();
    expect(getByText('+ Add from price book')).toBeTruthy();
    // Removing the row and saving sends the new lineItems array.
    fireEvent.click(getByText('Remove').closest('button')!);
    fireEvent.click(getByText('Save').closest('button')!);
    expect(h.edit).toHaveBeenCalledWith({ lineItems: [] });
  });

  it('clarifications offer no Edit (they resolve via chips)', () => {
    h.proposal = {
      id: 'p-cl',
      proposalType: 'voice_clarification',
      status: 'draft',
      summary: 'Which Bob?',
      payload: { reason: 'ambiguous_entity', entityCandidates: [{ id: 'c1', label: 'Bob' }] },
      approvedAt: null,
    };
    const { queryByText } = render(createElement(ProposalReviewScreen));
    expect(queryByText('Edit')).toBeNull();
  });
});
