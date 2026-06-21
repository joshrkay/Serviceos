import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactElement } from 'react';
import * as analytics from '../../lib/analytics';
import { FeaturesPage } from './FeaturesPage';
import { PricingPage } from './PricingPage';
import { AboutPage } from './AboutPage';
import { DownloadPage } from './DownloadPage';
import { PrivacyPage } from './PrivacyPage';
import { TermsPage } from './TermsPage';
import { StoreBadges } from './StoreBadges';

vi.mock('../../lib/analytics', () => ({
  track: vi.fn(),
  trackFunnel: vi.fn(),
}));

function renderAt(node: ReactElement) {
  return render(<MemoryRouter>{node}</MemoryRouter>);
}

/** Every primary CTA in the marketing site sends visitors to signup. */
function expectSignupCta() {
  const ctas = screen
    .getAllByRole('link')
    .filter((a) => a.getAttribute('href') === '/signup');
  expect(ctas.length).toBeGreaterThan(0);
}

describe('marketing pages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('FeaturesPage renders its headline, a signup CTA, and fires view_features', () => {
    renderAt(<FeaturesPage />);
    expect(
      screen.getByRole('heading', { name: /the whole back office, on autopilot/i }),
    ).toBeInTheDocument();
    expectSignupCta();
    expect(analytics.trackFunnel).toHaveBeenCalledWith('view_features');
  });

  it('PricingPage shows the $297 price, a signup CTA, and fires view_pricing', () => {
    renderAt(<PricingPage />);
    expect(screen.getByText('$297')).toBeInTheDocument();
    expectSignupCta();
    expect(analytics.trackFunnel).toHaveBeenCalledWith('view_pricing');
  });

  it('AboutPage renders the tagline, a signup CTA, and fires view_about', () => {
    renderAt(<AboutPage />);
    expect(screen.getByText(/we’ll run the business/i)).toBeInTheDocument();
    expectSignupCta();
    expect(analytics.trackFunnel).toHaveBeenCalledWith('view_about');
  });

  it('DownloadPage renders store badges, a signup CTA, and fires view_download', () => {
    renderAt(<DownloadPage />);
    expect(
      screen.getByRole('heading', { name: /run your shop from your pocket/i }),
    ).toBeInTheDocument();
    // Both store badges are present.
    expect(screen.getByLabelText(/download on the app store/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/get it on google play/i)).toBeInTheDocument();
    expectSignupCta();
    expect(analytics.trackFunnel).toHaveBeenCalledWith('view_download');
  });

  it('PrivacyPage and TermsPage render their titles and the draft banner', () => {
    const { unmount } = renderAt(<PrivacyPage />);
    expect(screen.getByRole('heading', { name: /privacy policy/i })).toBeInTheDocument();
    expect(screen.getByText(/pending legal review/i)).toBeInTheDocument();
    unmount();

    renderAt(<TermsPage />);
    expect(screen.getByRole('heading', { name: /terms of service/i })).toBeInTheDocument();
    expect(screen.getByText(/pending legal review/i)).toBeInTheDocument();
  });

  it('StoreBadges fire download_app_clicked with the store name on click', () => {
    renderAt(<StoreBadges />);
    screen.getByLabelText(/download on the app store/i).click();
    expect(analytics.track).toHaveBeenCalledWith('download_app_clicked', { store: 'ios' });
    screen.getByLabelText(/get it on google play/i).click();
    expect(analytics.track).toHaveBeenCalledWith('download_app_clicked', { store: 'android' });
  });
});
