import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { LeadCard, LeadCardData } from '../LeadCard';

const lead: LeadCardData = {
  id: 'lead-99',
  firstName: 'Carla',
  lastName: 'Reyes',
  source: 'referral',
  sourceDetail: 'thumbtack',
  stage: 'new',
  estimatedValueCents: 12500,
  email: 'carla@example.com',
};

describe('Leads — LeadCard (P9-001)', () => {
  it('renders name, source, and formatted dollar value', () => {
    render(<LeadCard lead={lead} />);
    expect(screen.getByText('Carla Reyes')).toBeInTheDocument();
    expect(screen.getByText('referral')).toBeInTheDocument();
    expect(screen.getByText('$125.00')).toBeInTheDocument();
  });

  it('falls back to company name when no first/last name is present', () => {
    render(<LeadCard lead={{ ...lead, firstName: undefined, lastName: undefined, companyName: 'Acme Co.' }} />);
    expect(screen.getByText('Acme Co.')).toBeInTheDocument();
  });

  it('invokes onClick when the card is clicked', () => {
    const onClick = vi.fn();
    render(<LeadCard lead={lead} onClick={onClick} />);
    fireEvent.click(screen.getByTestId('lead-card-lead-99'));
    expect(onClick).toHaveBeenCalledWith('lead-99');
  });

  // P12-005 — first-class customer_portal lead source.
  it('P12-005: renders customer_portal source with a globe icon', () => {
    const portalLead: LeadCardData = { ...lead, source: 'customer_portal' };
    render(<LeadCard lead={portalLead} />);
    const sourceBadge = screen.getByTestId('lead-source-customer_portal');
    expect(sourceBadge).toBeInTheDocument();
    expect(sourceBadge.textContent).toContain('customer_portal');
    // Globe glyph (U+1F310) — the icon mapping for the new source.
    expect(sourceBadge.textContent).toContain('\u{1F310}');
  });

  it('P12-005: falls back to a bullet for unknown source values', () => {
    const oddLead: LeadCardData = { ...lead, source: 'space_aliens' };
    render(<LeadCard lead={oddLead} />);
    const sourceBadge = screen.getByTestId('lead-source-space_aliens');
    expect(sourceBadge.textContent).toContain('•');
  });
});
