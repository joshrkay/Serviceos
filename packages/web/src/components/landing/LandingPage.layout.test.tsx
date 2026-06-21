import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, vi } from 'vitest';
import { LandingPage } from './LandingPage';

vi.mock('../../lib/analytics', () => ({
  track: vi.fn(),
  trackFunnel: vi.fn(),
}));

/**
 * jsdom class contract for the conversion overhaul (the measured-pixel
 * companion lives in e2e/marketing-mobile.spec.ts). Pins the trust bar, the
 * orange hero CTA, and the sticky mobile signup bar so a refactor can't
 * silently drop them or break the 320px stacking / ≥44px tap target.
 */
describe('LandingPage conversion layout', () => {
  function renderLanding() {
    return render(
      <MemoryRouter>
        <LandingPage />
      </MemoryRouter>,
    );
  }

  it('shows the honest trust bar with defensible, non-fabricated claims', () => {
    renderLanding();
    expect(screen.getByText(/replaces a \$2,400\+\/mo dispatcher/i)).toBeInTheDocument();
    expect(screen.getByText('Live in 15 minutes')).toBeInTheDocument();
    // "A second AI reviews every booking" intentionally echoes the trust
    // section pillar, so it appears more than once.
    expect(
      screen.getAllByText(/a second ai reviews every booking/i).length,
    ).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/cancel anytime — keep your data/i)).toBeInTheDocument();
  });

  it('makes the hero signup CTA the orange brand button', () => {
    renderLanding();
    // "Start 14-day free trial" appears on both the hero and the sticky bar;
    // both must be the orange brand CTA.
    const ctas = screen.getAllByRole('button', {
      name: /start 14-day free trial/i,
    });
    expect(ctas.length).toBeGreaterThanOrEqual(2);
    for (const cta of ctas) {
      expect(cta.className).toContain('bg-brand-accent');
    }
  });

  it('renders a sticky mobile-only signup bar with a ≥44px glove target', () => {
    const { container } = renderLanding();
    const bar = container.querySelector('div.fixed.bottom-0');
    expect(bar).not.toBeNull();
    // Mobile-only: it must not crowd the desktop layout.
    expect(bar!.className).toContain('sm:hidden');
    const cta = bar!.querySelector('button');
    expect(cta).not.toBeNull();
    expect(cta!.className).toContain('min-h-11');
    expect(cta!.className).toContain('bg-brand-accent');
  });
});
