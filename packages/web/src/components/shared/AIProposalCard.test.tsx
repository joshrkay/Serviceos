import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { AIProposalCard } from './AIProposalCard';
import type { AIProposal, ProposalConfidenceLevel } from '../../data/mock-data';

// sonner's <Toaster> isn't mounted in unit tests — the card imports
// `toast` at module scope, so stub it to keep the render side-effect-free.
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

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
});
