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

  it('renders "Unknown caller" for phone_call leads with no name', () => {
    render(
      <LeadCard
        lead={{
          ...lead,
          firstName: undefined,
          lastName: undefined,
          companyName: undefined,
          source: 'phone_call',
          primaryPhone: '+15125550100',
          email: undefined,
        }}
      />
    );
    expect(screen.getByText('Unknown caller')).toBeInTheDocument();
    expect(screen.getByText('+15125550100')).toBeInTheDocument();
  });

  it('renders "Unnamed lead" for non-phone-call leads with no name', () => {
    render(
      <LeadCard
        lead={{
          ...lead,
          firstName: undefined,
          lastName: undefined,
          companyName: undefined,
          source: 'web_form',
          email: undefined,
        }}
      />
    );
    expect(screen.getByText('Unnamed lead')).toBeInTheDocument();
  });

  it('invokes onClick when the card is clicked', () => {
    const onClick = vi.fn();
    render(<LeadCard lead={lead} onClick={onClick} />);
    fireEvent.click(screen.getByTestId('lead-card-lead-99'));
    expect(onClick).toHaveBeenCalledWith('lead-99');
  });
});
