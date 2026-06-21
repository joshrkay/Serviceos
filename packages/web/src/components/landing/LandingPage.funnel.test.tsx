import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as analytics from '../../lib/analytics';
import { LandingPage } from './LandingPage';

vi.mock('../../lib/analytics', () => ({
  track: vi.fn(),
  trackFunnel: vi.fn(),
}));

describe('LandingPage funnel instrumentation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fires view_landing once on mount', () => {
    render(
      <MemoryRouter>
        <LandingPage />
      </MemoryRouter>,
    );
    expect(analytics.trackFunnel).toHaveBeenCalledTimes(1);
    expect(analytics.trackFunnel).toHaveBeenCalledWith('view_landing');
  });

  it('tags the sticky mobile CTA so its conversions are attributable', () => {
    const { container } = render(
      <MemoryRouter>
        <LandingPage />
      </MemoryRouter>,
    );
    // The sticky bar is the fixed, bottom-anchored, mobile-only signup link.
    const stickyLink = container.querySelector<HTMLAnchorElement>(
      'div.fixed.bottom-0 a[href="/signup"]',
    );
    expect(stickyLink).not.toBeNull();
    stickyLink!.click();
    expect(analytics.track).toHaveBeenCalledWith('landing_signup_clicked', {
      location: 'sticky',
    });
  });
});
