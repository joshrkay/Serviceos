import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Replace Clerk's <SignUp> (which needs a ClerkProvider) with a stub, and
// keep the user signed-out so SignupPage renders the form (not a redirect).
const signUpProps = vi.fn();
vi.mock('@clerk/clerk-react', () => ({
  useAuth: () => ({ isLoaded: true, isSignedIn: false }),
  SignUp: (props: Record<string, unknown>) => {
    signUpProps(props);
    return <div data-testid="clerk-signup" />;
  },
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
  afterEach(() => {
    window.history.replaceState(null, '', '/');
    document.cookie = 'rvt_ft=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
  });

  function renderPage() {
    render(
      <MemoryRouter>
        <SignupPage />
      </MemoryRouter>,
    );
  }

  it('fires signup_started once on mount', () => {
    render(
      <MemoryRouter>
        <SignupPage />
      </MemoryRouter>,
    );
    expect(analytics.trackFunnel).toHaveBeenCalledTimes(1);
    expect(analytics.trackFunnel).toHaveBeenCalledWith('signup_started');
  });

  it('passes no unsafeMetadata when there is no attribution', () => {
    renderPage();
    expect(signUpProps).toHaveBeenCalledWith(expect.objectContaining({ unsafeMetadata: undefined }));
  });

  it('forwards URL attribution to Clerk unsafeMetadata and signup_started', () => {
    window.history.replaceState(
      null,
      '',
      '/signup?utm_source=google&utm_campaign=spring&rvt_landing=%2Fpricing&rvt_ref=https%3A%2F%2Fwww.google.com%2F%3Fq%3Dx',
    );
    renderPage();
    const expected = {
      utmSource: 'google',
      utmCampaign: 'spring',
      landing: '/pricing',
      ref: 'https://www.google.com/',
    };
    expect(signUpProps).toHaveBeenCalledWith(
      expect.objectContaining({ unsafeMetadata: { signupAttribution: expected } }),
    );
    expect(analytics.trackFunnel).toHaveBeenCalledWith('signup_started', undefined, {
      utm_source: 'google',
      utm_campaign: 'spring',
      signup_landing_section: '/pricing',
      signup_referrer_host: 'www.google.com',
    });
  });

  it('falls back to the rvt_ft cookie when the URL carries nothing', () => {
    document.cookie = `rvt_ft=${encodeURIComponent(
      JSON.stringify({ ref: 'https://news.ycombinator.com/', landing: '/blog', at: '2026-10-01', utm_source: 'hn' }),
    )}; path=/`;
    renderPage();
    expect(signUpProps).toHaveBeenCalledWith(
      expect.objectContaining({
        unsafeMetadata: {
          signupAttribution: {
            utmSource: 'hn',
            ref: 'https://news.ycombinator.com/',
            landing: '/blog',
            firstTouchAt: '2026-10-01',
          },
        },
      }),
    );
  });
});
