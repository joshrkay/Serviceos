import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { SocialProof } from './SocialProof';
import { testimonials } from './socialProof';
import type { Testimonial } from './socialProof';

describe('SocialProof', () => {
  it('ships no fabricated testimonials by default (early access)', () => {
    // Guards the honesty constraint: until real, attributable quotes exist the
    // shipped array must stay empty so nothing fake reaches the marketing site.
    expect(testimonials).toEqual([]);
  });

  it('renders the honest early-access block when there are no testimonials', () => {
    render(<SocialProof items={[]} />);
    expect(
      screen.getByRole('heading', { name: /built with owner-operators/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/talk to the people building it/i),
    ).toBeInTheDocument();
    // It must NOT pretend to have field quotes when the array is empty.
    expect(
      screen.queryByRole('heading', { name: /stopped dispatching from the attic/i }),
    ).not.toBeInTheDocument();
  });

  it('renders the testimonial grid when quotes are present', () => {
    const seeded: Testimonial[] = [
      {
        quote: 'Booked 4 jobs while I was in an attic. Paid for itself week one.',
        name: 'Marco',
        trade: 'HVAC',
        city: 'Phoenix, AZ',
        date: '2026-03-01',
      },
    ];
    render(<SocialProof items={seeded} />);
    expect(screen.getByText(/booked 4 jobs while i was in an attic/i)).toBeInTheDocument();
    expect(screen.getByText('Marco')).toBeInTheDocument();
    expect(screen.getByText(/HVAC, Phoenix, AZ/)).toBeInTheDocument();
    // ISO date renders as a human "Mon YYYY" byline.
    expect(screen.getByText('Mar 2026')).toBeInTheDocument();
    // The early-access fallback is gone once real proof exists.
    expect(
      screen.queryByText(/talk to the people building it/i),
    ).not.toBeInTheDocument();
  });
});
