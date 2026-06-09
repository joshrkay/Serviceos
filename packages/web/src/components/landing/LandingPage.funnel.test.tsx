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
});
