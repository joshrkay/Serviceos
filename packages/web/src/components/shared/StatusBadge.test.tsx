import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { StatusBadge, toneForStatus } from './StatusBadge';

describe('toneForStatus', () => {
  it('maps statuses to the branded tone set, unknown → neutral', () => {
    expect(toneForStatus('Paid')).toBe('success');
    expect(toneForStatus('Approved')).toBe('success');
    expect(toneForStatus('Overdue')).toBe('destructive');
    expect(toneForStatus('Declined')).toBe('destructive');
    expect(toneForStatus('Scheduled')).toBe('warning');
    expect(toneForStatus('Unpaid')).toBe('warning');
    expect(toneForStatus('Sent')).toBe('info');
    expect(toneForStatus('Draft')).toBe('neutral');
    expect(toneForStatus('Something else')).toBe('neutral');
  });
});

describe('StatusBadge', () => {
  it('renders the status label with the tone token classes', () => {
    render(<StatusBadge status="Paid" />);
    const badge = screen.getByText('Paid');
    expect(badge.className).toContain('text-success');
    expect(badge.className).toContain('bg-success/10');
    // No raw palette leaks through.
    expect(badge.className).not.toMatch(/(bg|text)-(green|blue|red|amber)-\d{2,3}/);
  });

  it('uses the destructive tone for a bad status', () => {
    render(<StatusBadge status="Overdue" />);
    expect(screen.getByText('Overdue').className).toContain('text-destructive');
  });

  it('noBackground variant drops the pill background but keeps the tone text', () => {
    render(<StatusBadge status="Draft" noBackground />);
    const badge = screen.getByText('Draft');
    expect(badge.className).toContain('text-muted-foreground');
    expect(badge.className).not.toContain('bg-secondary');
  });
});
