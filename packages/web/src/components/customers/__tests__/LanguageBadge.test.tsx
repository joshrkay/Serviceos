import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { LanguageBadge } from '../LanguageBadge';

describe('P11-002 LanguageBadge', () => {
  it('Language: renders Spanish label when preferredLanguage is es', () => {
    render(<LanguageBadge language="es" />);
    const badge = screen.getByTestId('language-badge');
    expect(badge).toHaveAttribute('data-language', 'es');
    expect(badge.textContent).toContain('Español');
  });

  it('Language: renders English label when preferredLanguage is en', () => {
    render(<LanguageBadge language="en" />);
    expect(screen.getByTestId('language-badge').textContent).toContain('English');
  });

  it('Multilingual: renders nothing when language is undefined', () => {
    const { container } = render(<LanguageBadge />);
    expect(container.firstChild).toBeNull();
  });

  it('Multilingual: renders nothing when language is null', () => {
    const { container } = render(<LanguageBadge language={null} />);
    expect(container.firstChild).toBeNull();
  });
});
