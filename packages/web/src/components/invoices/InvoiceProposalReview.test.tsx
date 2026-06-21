import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { InvoiceProposalReview, InvoiceProposalData } from './InvoiceProposalReview';

function makeProposal(overrides: Partial<InvoiceProposalData> = {}): InvoiceProposalData {
  return {
    id: 'prop-1',
    customerId: 'cust-1',
    jobId: 'job-1',
    lineItems: [
      { description: 'Labor', quantity: 2, unitPrice: 5000 },
      { description: 'Parts', quantity: 1, unitPrice: 3000 },
    ],
    discountCents: 0,
    taxRateBps: 0,
    subtotalCents: 13000,
    taxCents: 0,
    totalCents: 13000,
    status: 'pending',
    ...overrides,
  };
}

describe('P5-004A InvoiceProposalReview', () => {
  it('renders line items table with all columns', () => {
    render(<InvoiceProposalReview proposal={makeProposal()} />);
    const table = screen.getByTestId('line-items-table');
    expect(table).toBeDefined();
    expect(screen.getByText('Description')).toBeDefined();
    expect(screen.getByText('Qty')).toBeDefined();
    expect(screen.getByText('Unit Price')).toBeDefined();
    expect(screen.getByText('Total')).toBeDefined();
    expect(screen.getByText('Labor')).toBeDefined();
    expect(screen.getByText('Parts')).toBeDefined();
  });

  it('displays totals section with subtotal and total', () => {
    render(<InvoiceProposalReview proposal={makeProposal()} />);
    const totals = screen.getByTestId('totals-section');
    expect(totals).toBeDefined();
    expect(screen.getByTestId('subtotal')).toBeDefined();
    expect(screen.getByTestId('total')).toBeDefined();
  });

  it('shows confidence score when present', () => {
    render(<InvoiceProposalReview proposal={makeProposal({ confidenceScore: 0.95 })} />);
    const score = screen.getByTestId('confidence-score');
    expect(score.textContent).toContain('95%');
  });

  it('shows explanation when present', () => {
    render(
      <InvoiceProposalReview proposal={makeProposal({ explanation: 'Based on estimate' })} />
    );
    const el = screen.getByTestId('proposal-explanation');
    expect(el.textContent).toContain('Based on estimate');
  });

  it('shows customer message when present', () => {
    render(
      <InvoiceProposalReview proposal={makeProposal({ customerMessage: 'Thank you' })} />
    );
    const el = screen.getByTestId('customer-message');
    expect(el.textContent).toContain('Thank you');
  });

  it('shows estimate reference when present', () => {
    render(
      <InvoiceProposalReview proposal={makeProposal({ estimateId: 'est-42' })} />
    );
    const el = screen.getByTestId('estimate-reference');
    expect(el.textContent).toContain('est-42');
  });

  it('hides discount row when discount is zero', () => {
    render(<InvoiceProposalReview proposal={makeProposal({ discountCents: 0 })} />);
    expect(screen.queryByTestId('discount')).toBeNull();
  });

  it('shows discount row when discount is positive', () => {
    render(
      <InvoiceProposalReview
        proposal={makeProposal({ discountCents: 500, totalCents: 12500 })}
      />
    );
    expect(screen.getByTestId('discount')).toBeDefined();
  });

  it('hides tax row when tax rate is zero', () => {
    render(<InvoiceProposalReview proposal={makeProposal({ taxRateBps: 0 })} />);
    expect(screen.queryByTestId('tax')).toBeNull();
  });

  it('shows tax row when tax rate is positive', () => {
    render(
      <InvoiceProposalReview
        proposal={makeProposal({ taxRateBps: 800, taxCents: 1000 })}
      />
    );
    expect(screen.getByTestId('tax')).toBeDefined();
  });

  // P2-035 (U2) — confidence markers + per-line pricing-source badges.
  it('renders the 4-tier confidence chip from _meta and hides the coarse score', () => {
    render(
      <InvoiceProposalReview
        proposal={makeProposal({
          confidenceScore: 0.4,
          meta: { overallConfidence: 'low' },
        })}
      />,
    );
    const chip = screen.getByTestId('confidence-level');
    expect(chip.getAttribute('data-level')).toBe('low');
    expect(chip.textContent).toContain('Low confidence');
    // The coarse percentage is suppressed once the 4-tier chip renders.
    expect(screen.queryByTestId('confidence-score')).toBeNull();
  });

  it('surfaces _meta.markers as "what I wasn\'t sure about" callouts', () => {
    render(
      <InvoiceProposalReview
        proposal={makeProposal({
          meta: {
            overallConfidence: 'low',
            markers: [
              { path: 'lineItems[0].unitPriceCents', reason: '"Widget" is not in the tenant catalog' },
            ],
          },
        })}
      />,
    );
    const markers = screen.getByTestId('confidence-markers');
    expect(markers.textContent).toContain('Widget');
  });

  it('badges an uncatalogued line and skips manual lines', () => {
    render(
      <InvoiceProposalReview
        proposal={makeProposal({
          lineItems: [
            { description: 'Mystery part', quantity: 1, unitPrice: 5000, pricingSource: 'uncatalogued' },
            { description: 'Hand-keyed', quantity: 1, unitPrice: 2000, pricingSource: 'manual' },
          ],
          subtotalCents: 7000,
          totalCents: 7000,
        })}
      />,
    );
    expect(screen.getByTestId('pricing-source-uncatalogued')).toBeDefined();
    expect(screen.queryByTestId('pricing-source-manual')).toBeNull();
  });
});
