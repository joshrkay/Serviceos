import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, vi } from 'vitest';
import { StoreBadges } from './StoreBadges';
import { MarketingCTA } from './MarketingCTA';
import { MarketingHeader } from './MarketingHeader';

vi.mock('../../lib/analytics', () => ({
  track: vi.fn(),
  trackFunnel: vi.fn(),
}));

/**
 * jsdom class contract for the marketing CTAs (the measured-pixel companion
 * lives in e2e/marketing-mobile.spec.ts). Glove-friendly rule from CLAUDE.md:
 * primary public tap targets are ≥44px tall (min-h-11 or the lg button's h-12),
 * and the badges stack rather than overflow at 320px.
 */
describe('marketing CTA tap-target contract', () => {
  it('store badges are ≥44px tall (min-h-11) and stack on narrow screens', () => {
    render(
      <MemoryRouter>
        <StoreBadges />
      </MemoryRouter>,
    );
    const badges = [
      screen.getByLabelText(/download on the app store/i),
      screen.getByLabelText(/get it on google play/i),
    ];
    for (const badge of badges) {
      expect(badge.className).toContain('min-h-11');
    }
    // The wrapper stacks vertically first, going horizontal only at ≥sm.
    const wrapper = badges[0].parentElement!;
    expect(wrapper.className).toContain('flex-col');
    expect(wrapper.className).toContain('sm:flex-row');
  });

  it('the primary trial CTA uses the lg button (h-12 ≥ 44px)', () => {
    render(
      <MemoryRouter>
        <MarketingCTA location="test" />
      </MemoryRouter>,
    );
    const cta = screen.getByRole('button', { name: /start free trial/i });
    expect(cta.className).toContain('h-12');
  });

  it('the header keeps the logo, nav routes, and both auth CTAs', () => {
    render(
      <MemoryRouter>
        <MarketingHeader />
      </MemoryRouter>,
    );
    // Nav points at real routes, not dead anchors.
    expect(screen.getByRole('link', { name: /^features$/i })).toHaveAttribute(
      'href',
      '/features',
    );
    expect(screen.getByRole('link', { name: /^pricing$/i })).toHaveAttribute(
      'href',
      '/pricing',
    );
    expect(screen.getByRole('button', { name: /log in/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /start free trial/i })).toBeInTheDocument();
  });
});
