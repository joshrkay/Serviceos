import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { Button } from './button';

describe('Button', () => {
  it('defaults to the primary slate variant', () => {
    render(<Button>Go</Button>);
    expect(screen.getByRole('button', { name: 'Go' }).className).toContain(
      'bg-slate-900',
    );
  });

  it('renders the brand variant with the orange accent tokens', () => {
    render(<Button variant="brand">Start free trial</Button>);
    const btn = screen.getByRole('button', { name: /start free trial/i });
    // The brand CTA uses the themeable orange accent, not a hard-coded color,
    // so the design token is the single source of truth.
    expect(btn.className).toContain('bg-brand-accent');
    expect(btn.className).toContain('text-brand-accent-foreground');
    expect(btn.className).toContain('hover:bg-brand-accent-hover');
  });

  it('the lg size is a ≥44px glove target (h-12)', () => {
    render(
      <Button variant="brand" size="lg">
        Start free trial
      </Button>,
    );
    expect(
      screen.getByRole('button', { name: /start free trial/i }).className,
    ).toContain('h-12');
  });
});
