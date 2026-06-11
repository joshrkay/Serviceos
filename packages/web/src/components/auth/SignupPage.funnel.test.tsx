import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Replace Clerk's <SignUp> (which needs a ClerkProvider) with a stub, and
// keep the user signed-out so SignupPage renders the form (not a redirect).
vi.mock('@clerk/clerk-react', () => ({
  useAuth: () => ({ isLoaded: true, isSignedIn: false }),
  SignUp: () => <div data-testid="clerk-signup" />,
}));

vi.mock('../../lib/analytics', () => ({
  trackFunnel: vi.fn(),
}));

import * as analytics from '../../lib/analytics';
import { SignupPage } from './SignupPage';

describe('SignupPage funnel instrumentation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fires signup_started once on mount', () => {
    render(
      <MemoryRouter>
        <SignupPage />
      </MemoryRouter>,
    );
    expect(analytics.trackFunnel).toHaveBeenCalledTimes(1);
    expect(analytics.trackFunnel).toHaveBeenCalledWith('signup_started');
  });
});
