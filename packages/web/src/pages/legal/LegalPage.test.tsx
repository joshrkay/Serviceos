import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { PrivacyPolicy } from './PrivacyPolicy';
import { TermsOfService } from './TermsOfService';

/**
 * Class-contract + content tests for the public legal pages. The "no horizontal
 * overflow at 320px" invariant is measured by Playwright (legal-mobile.spec.ts);
 * jsdom can't lay out, so here we pin the structure: required sections render,
 * the column is width-capped (`max-w-3xl`), the back link is a ≥44px tap target
 * (`min-h-11`), and both pages link back to `/`.
 */
describe('Privacy Policy page', () => {
  it('renders the title and key sections', () => {
    render(<PrivacyPolicy />);
    expect(screen.getByRole('heading', { level: 1, name: /privacy policy/i })).toBeTruthy();
    for (const heading of [
      /information we collect/i,
      /how we use information/i,
      /how we share information/i,
      /data retention and deletion/i,
      /security/i,
    ]) {
      expect(screen.getByRole('heading', { name: heading })).toBeTruthy();
    }
  });

  it('points users to in-app account deletion', () => {
    render(<PrivacyPolicy />);
    expect(screen.getByText(/delete your account/i)).toBeTruthy();
  });

  it('caps the content column width and exposes a ≥44px back link to home', () => {
    const { container } = render(<PrivacyPolicy />);
    expect(container.querySelector('.max-w-3xl')).toBeTruthy();
    const back = screen.getByRole('link', { name: /back to home/i });
    expect(back.getAttribute('href')).toBe('/');
    expect(back.className).toMatch(/\bmin-h-11\b/);
  });
});

describe('Terms of Service page', () => {
  it('renders the title and key sections', () => {
    render(<TermsOfService />);
    expect(screen.getByRole('heading', { level: 1, name: /terms of service/i })).toBeTruthy();
    for (const heading of [
      /the service/i,
      /subscription and billing/i,
      /acceptable use/i,
      /your data and ownership/i,
      /ai-generated content/i,
      /disclaimers and limitation of liability/i,
    ]) {
      expect(screen.getByRole('heading', { name: heading })).toBeTruthy();
    }
  });

  it('links back to home from a ≥44px tap target', () => {
    render(<TermsOfService />);
    const back = screen.getByRole('link', { name: /back to home/i });
    expect(back.getAttribute('href')).toBe('/');
    expect(back.className).toMatch(/\bmin-h-11\b/);
  });

  it('flags the copy as a draft pending review', () => {
    const { container } = render(<TermsOfService />);
    expect(within(container).getByText(/draft for review/i)).toBeTruthy();
  });
});
