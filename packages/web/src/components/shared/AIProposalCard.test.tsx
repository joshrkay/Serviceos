import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within, fireEvent, act } from '@testing-library/react';
import { AIProposalCard } from './AIProposalCard';
import type { AIProposal, ProposalConfidenceLevel } from '../../types/assistant-ui';

// sonner's <Toaster> isn't mounted in unit tests — the card imports
// `toast` at module scope, so stub it to keep the render side-effect-free.
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

// The card calls useNavigate (Story 3.11 deep-link). Mock it so renders need
// no Router wrapper and the navigation target is assertable.
const navigateMock = vi.fn();
vi.mock('react-router', async (orig) => {
  const actual = await (orig() as Promise<typeof import('react-router')>);
  return { ...actual, useNavigate: () => navigateMock };
});

function makeProposal(overrides: Partial<AIProposal> = {}): AIProposal {
  return {
    id: 'prop-1',
    title: 'Draft estimate for the Hendersons',
    summary: 'Two lines, one needs a price.',
    explanation: 'Drafted from the voice note.',
    confidence: 'Medium',
    type: 'Estimate',
    status: 'Pending',
    ...overrides,
  };
}

describe('P2-035 (U2) AIProposalCard confidence markers', () => {
  // The 4-tier `_meta.overallConfidence` config drives the confidence
  // label/bar. Each tier must render its own human label.
  const tierLabels: Record<ProposalConfidenceLevel, string> = {
    high: 'High confidence',
    medium: 'Review recommended',
    low: 'Low confidence',
    very_low: 'Very low confidence',
  };

  (Object.keys(tierLabels) as ProposalConfidenceLevel[]).forEach((level) => {
    it(`renders the '${level}' confidence tier from _meta.overallConfidence`, () => {
      render(
        <AIProposalCard
          proposal={makeProposal({ meta: { overallConfidence: level } })}
        />,
      );
      expect(screen.getByText(tierLabels[level])).toBeInTheDocument();
    });
  });

  it('falls back to the coarse 2-tier bar when _meta is absent', () => {
    // No `meta` → the card uses the legacy `confidence` field ('Medium').
    render(<AIProposalCard proposal={makeProposal({ confidence: 'High' })} />);
    expect(screen.getByText('High confidence')).toBeInTheDocument();
  });

  // §6.4-B (U5) — severity badge from `_meta.severity` (MMS photo drafts).
  it('renders the §6.4-B severity badge from _meta.severity', () => {
    render(
      <AIProposalCard
        proposal={makeProposal({
          meta: { overallConfidence: 'medium', severity: 'TIER_2_EMERGENCY_DISPATCH' },
        })}
      />,
    );
    expect(screen.getByTestId('severity-badge')).toHaveTextContent('Emergency');
  });

  it('omits the severity badge when _meta has no severity', () => {
    render(
      <AIProposalCard proposal={makeProposal({ meta: { overallConfidence: 'medium' } })} />,
    );
    expect(screen.queryByTestId('severity-badge')).toBeNull();
  });

  it('does not crash when _meta carries an unknown overallConfidence', () => {
    // Defensive: a malformed level must not throw — the card falls back to
    // the coarse bar rather than indexing undefined config.
    render(
      <AIProposalCard
        proposal={makeProposal({
          confidence: 'Medium',
          // @ts-expect-error — exercising the runtime guard with a bad level
          meta: { overallConfidence: 'bogus' },
        })}
      />,
    );
    expect(screen.getByText('Review recommended')).toBeInTheDocument();
  });

  it('renders an uncatalogued pricingSource badge and a marker reason', () => {
    render(
      <AIProposalCard
        proposal={makeProposal({
          lineItems: [
            { description: 'Mystery widget', pricingSource: 'uncatalogued' },
          ],
          meta: {
            overallConfidence: 'low',
            markers: [
              {
                path: 'lineItems[0].unitPrice',
                reason: '"Mystery widget" is not in the tenant catalog — the price is AI-estimated and needs review',
              },
            ],
          },
        })}
      />,
    );

    // Per-line catalog-grounding badge for the uncatalogued line.
    expect(screen.getByTestId('pricing-source-uncatalogued')).toBeInTheDocument();
    expect(screen.getByTestId('pricing-source-uncatalogued')).toHaveTextContent('AI-estimated');

    // "What I wasn't sure about" marker reason surfaces verbatim.
    const markers = screen.getByTestId('confidence-markers');
    expect(within(markers).getByText(/Mystery widget/)).toBeInTheDocument();
    expect(within(markers).getByText(/AI-estimated and needs review/)).toBeInTheDocument();
  });

  it('skips the badge for manual-priced lines', () => {
    render(
      <AIProposalCard
        proposal={makeProposal({
          lineItems: [{ description: 'Hand-keyed line', pricingSource: 'manual' }],
        })}
      />,
    );
    expect(screen.queryByTestId('pricing-source-badges')).toBeNull();
  });

  // UB-A3 — "Standing instruction applied" chips from
  // `_meta.appliedStandingInstructions` (server-side intersected ids).
  it('renders a "Standing instruction applied" chip per applied instruction (UB-A3)', () => {
    render(
      <AIProposalCard
        proposal={makeProposal({
          meta: {
            overallConfidence: 'high',
            appliedStandingInstructions: [
              { id: 'si-1', text: 'Always add a $50 trip fee' },
              { id: 'si-2', text: 'Mention the referral discount' },
            ],
          },
        })}
      />,
    );

    const chips = screen.getAllByTestId('standing-instruction-chip');
    expect(chips).toHaveLength(2);
    expect(chips[0]).toHaveTextContent('Standing instruction applied: Always add a $50 trip fee');
    expect(chips[1]).toHaveTextContent('Standing instruction applied: Mention the referral discount');
  });

  it('omits the standing-instruction chips when _meta carries none (UB-A3)', () => {
    render(
      <AIProposalCard proposal={makeProposal({ meta: { overallConfidence: 'high' } })} />,
    );
    expect(screen.queryByTestId('standing-instruction-chips')).toBeNull();
  });
});

describe('Story 3.11 — approved proposal deep-links to the created entity', () => {
  beforeEach(() => navigateMock.mockReset());

  it.each([
    ['Invoice', 'inv-1', '/invoices/inv-1'],
    ['Send', 'inv-9', '/invoices/inv-9'],
    ['Estimate', 'est-2', '/estimates/est-2'],
    ['Customer', 'cus-3', '/customers/cus-3'],
  ] as const)('navigates a %s card to its entity', (type, relatedId, route) => {
    render(
      <AIProposalCard
        proposal={makeProposal({ status: 'Approved', type, relatedId })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /view/i }));
    expect(navigateMock).toHaveBeenCalledWith(route);
  });

  it('shows no View button for a type without a detail route', () => {
    render(
      <AIProposalCard
        proposal={makeProposal({ status: 'Approved', type: 'Schedule', relatedId: 'appt-1' })}
      />,
    );
    expect(screen.queryByRole('button', { name: /view/i })).toBeNull();
  });

  it('shows no View button when relatedId is absent', () => {
    render(
      <AIProposalCard proposal={makeProposal({ status: 'Approved', type: 'Invoice' })} />,
    );
    expect(screen.queryByRole('button', { name: /view/i })).toBeNull();
  });

  it('keeps the View tap target ≥44px (min-h-11)', () => {
    render(
      <AIProposalCard
        proposal={makeProposal({ status: 'Approved', type: 'Invoice', relatedId: 'inv-1' })}
      />,
    );
    expect(screen.getByRole('button', { name: /view/i }).className).toContain('min-h-11');
  });
});

/**
 * Follow-up review remnant — the assistant chat can now surface a proposal the
 * server AUTO-APPROVED and queued for execution with no human tap. That card
 * arrives with `status: 'Approved'` and took the same terminal branch as a
 * card the operator just approved, which said "Applied successfully".
 *
 * Two lies in one line. The operator did not approve it — nothing was tapped —
 * and it has not applied: auto-approval stamps `approvedAt` and the execution
 * sweep only picks the row up after the undo window closes, so at render time
 * the write has NOT happened and is still cancellable.
 *
 * Review J7 OVERRIDES the original decision to leave the MANUAL path alone.
 * That rationale answered the ATTRIBUTION half of the lie and ignored the
 * COMPLETION half, which is the half the ticket named:
 * `findReadyForExecution` requires `approved_at <= NOW() - windowMs`
 * (pg-proposal.ts), so at the instant "Applied successfully" rendered,
 * NOTHING had applied — identically to the auto path. Worse,
 * `AssistantPage` raises the undo toast on the same tick, so the UI said
 * "Applied successfully" while offering to undo it. Both branches now say
 * "Approved — applying shortly."; only the auto path adds the attribution
 * clause.
 */
describe('auto-approved card — honest copy', () => {
  beforeEach(() => navigateMock.mockReset());

  it('does not claim the operator applied it when the card arrives already Approved', () => {
    render(<AIProposalCard proposal={makeProposal({ status: 'Approved' })} />);
    expect(screen.queryByText('Applied successfully')).toBeNull();
  });

  it('says it was approved automatically and has not applied yet', () => {
    render(<AIProposalCard proposal={makeProposal({ status: 'Approved' })} />);
    expect(screen.getByText(/approved automatically/i)).toBeInTheDocument();
    // "will apply" / "applying" — a future/in-flight write, never a completed one.
    expect(screen.getByText(/appl(y|ying)/i)).toBeInTheDocument();
  });

  it('does not claim the operator-approved path APPLIED either — nothing has (J7)', () => {
    render(<AIProposalCard proposal={makeProposal({ status: 'Pending' })} onApprove={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /approve/i }));
    expect(screen.queryByText(/applied successfully/i)).toBeNull();
    expect(screen.getByText(/applying shortly/i)).toBeInTheDocument();
    // The attribution clause belongs only to the auto path — here the
    // operator DID tap Approve.
    expect(screen.queryByText(/nobody tapped approve/i)).toBeNull();
    expect(screen.queryByText(/approved automatically/i)).toBeNull();
  });

  it('still deep-links to the created entity on the auto-approved path', () => {
    render(
      <AIProposalCard
        proposal={makeProposal({ status: 'Approved', type: 'Invoice', relatedId: 'inv-7' })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /view/i }));
    expect(navigateMock).toHaveBeenCalledWith('/invoices/inv-7');
  });
});

/**
 * Review J5 — #28's recovery path ("the operator's recovery is one field
 * edit, not a re-utterance") was FALSE on the web chat card.
 *
 * The server half is fine: `approveProposal` blocks on the tracked list,
 * `clearSatisfiedMissingFields` lifts on an exact flat-key edit,
 * `proposedUnitPriceCents` IS a flat key, and the contract carries no
 * ceiling so a deliberate $290,000 edit passes. The CLIENT was broken: the
 * card's inputs produce `Record<string, string>`, `editProposalBodySchema`
 * is `z.record(z.unknown())` with NO coercion, so `PUT` sent
 * `{proposedUnitPriceCents: "29000000"}` against a `z.number()` field →
 * 400 "Invalid payload after edit" → the operator got "Couldn't apply this
 * suggestion. Please try again."
 *
 * Fixed by giving `editFields` a `kind`, mirroring mobile's
 * `editableScalarFields`/`parseMoneyToCents`, which works correctly today.
 * A `kind: 'cents'` field is DOLLARS in the input and integer cents on the
 * wire — server-side coercion could not do this, because coercing the
 * string "290000" would mean 290000 CENTS ($2,900), wrong by 100x on a
 * money field.
 */
describe('AIProposalCard — typed edit fields (review J5)', () => {
  beforeEach(() => navigateMock.mockReset());

  const gated = (): AIProposal =>
    makeProposal({
      type: 'Follow-up',
      missingFields: ['proposedUnitPriceCents'],
      editFields: [
        {
          label: 'Unit price ($)',
          key: 'proposedUnitPriceCents',
          kind: 'cents',
          value: '89.00',
        },
      ],
    });

  function openEditor() {
    fireEvent.click(screen.getByRole('button', { name: /edit/i }));
  }

  it('sends integer CENTS for a cents field, not the raw input string', async () => {
    const onApprove = vi.fn().mockResolvedValue(undefined);
    render(<AIProposalCard proposal={gated()} onApprove={onApprove} />);

    openEditor();
    fireEvent.change(screen.getByLabelText('Unit price ($)'), { target: { value: '290000' } });
    fireEvent.click(screen.getByRole('button', { name: /save & apply/i }));

    await vi.waitFor(() => expect(onApprove).toHaveBeenCalled());
    expect(onApprove).toHaveBeenCalledWith({ proposedUnitPriceCents: 29_000_000 });
  });

  it('parses dollars-and-cents input exactly, without float multiplication', async () => {
    const onApprove = vi.fn().mockResolvedValue(undefined);
    render(<AIProposalCard proposal={gated()} onApprove={onApprove} />);

    openEditor();
    fireEvent.change(screen.getByLabelText('Unit price ($)'), { target: { value: '0.29' } });
    fireEvent.click(screen.getByRole('button', { name: /save & apply/i }));

    await vi.waitFor(() => expect(onApprove).toHaveBeenCalled());
    expect(onApprove).toHaveBeenCalledWith({ proposedUnitPriceCents: 29 });
  });

  it('refuses to submit an unparseable money input instead of sending a 400-bound string', () => {
    const onApprove = vi.fn().mockResolvedValue(undefined);
    render(<AIProposalCard proposal={gated()} onApprove={onApprove} />);

    openEditor();
    fireEvent.change(screen.getByLabelText('Unit price ($)'), { target: { value: 'two ninety' } });
    fireEvent.click(screen.getByRole('button', { name: /save & apply/i }));

    expect(onApprove).not.toHaveBeenCalled();
    expect(screen.getByTestId('edit-field-error')).toHaveTextContent(/Unit price/);
  });

  it('leaves an untyped (text) field exactly as before — a string on the wire', async () => {
    const onApprove = vi.fn().mockResolvedValue(undefined);
    render(
      <AIProposalCard
        proposal={makeProposal({
          type: 'Follow-up',
          editFields: [{ label: 'Invoice # or ID', key: 'invoiceId', value: 'Henderson' }],
        })}
        onApprove={onApprove}
      />,
    );

    openEditor();
    fireEvent.change(screen.getByLabelText('Invoice # or ID'), { target: { value: 'INV-9' } });
    fireEvent.click(screen.getByRole('button', { name: /save & apply/i }));

    await vi.waitFor(() => expect(onApprove).toHaveBeenCalled());
    expect(onApprove).toHaveBeenCalledWith({ invoiceId: 'INV-9' });
  });
});

/**
 * Review N10 — the terminal line was snapshotted at FIRST RENDER
 * (`arrivedAutoApproved` via a useState initialiser, plus a static string),
 * so after a successful undo the card still said "Applying shortly; undo
 * now" for something just cancelled, and it kept saying it long after the
 * window had lapsed. The line must come off live state.
 */
describe('auto-approved card — the terminal line tracks live state', () => {
  beforeEach(() => {
    navigateMock.mockReset();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const approvedWithWindow = (msLeft: number): AIProposal =>
    makeProposal({
      status: 'Approved',
      undoExpiresAt: new Date(Date.now() + msLeft).toISOString(),
    });

  it('offers the undo clause only while the window is genuinely open', () => {
    render(<AIProposalCard proposal={approvedWithWindow(5000)} />);
    expect(screen.getByText(/undo now/i)).toBeInTheDocument();

    act(() => { vi.advanceTimersByTime(5200); });

    expect(screen.queryByText(/undo now/i)).toBeNull();
    // Still honest about what happens next — the sweep picks it up now.
    expect(screen.getByText(/applying shortly/i)).toBeInTheDocument();
  });

  it('never offers an undo clause for an approved card with no window at all', () => {
    render(<AIProposalCard proposal={makeProposal({ status: 'Approved' })} />);
    expect(screen.queryByText(/undo now/i)).toBeNull();
  });

  it('says the write was cancelled once the proposal comes back Undone', () => {
    const { rerender } = render(<AIProposalCard proposal={approvedWithWindow(5000)} />);
    expect(screen.getByText(/applying shortly/i)).toBeInTheDocument();

    rerender(<AIProposalCard proposal={{ ...approvedWithWindow(5000), status: 'Undone' }} />);

    expect(screen.queryByText(/applying shortly/i)).toBeNull();
    expect(screen.getByText(/undone/i)).toBeInTheDocument();
    expect(screen.queryByText(/undo now/i)).toBeNull();
  });
});
