import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, fireEvent } from '@testing-library/react';
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
