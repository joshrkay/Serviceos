/**
 * Mobile/glove layout contract for the voice "you can say…" strip.
 *
 * jsdom can't measure real overflow, so these pin the CSS class contract the
 * mobile fix depends on (min-h-11 ≥44px tap targets, overflow-x-auto + min-w-0
 * so the row scrolls internally instead of widening the bar). Real px / overflow
 * measurement lives in e2e/voice-suggestions-mobile.spec.ts (320px/390px).
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { VoiceSuggestionsStrip } from './VoiceSuggestionsStrip';

const SUGGESTIONS = ["What's on today's schedule?", 'Any overdue invoices?'];

describe('VoiceSuggestionsStrip', () => {
  it('renders a chip per suggestion and pre-fills via onPick with the exact text', () => {
    const onPick = vi.fn();
    render(<VoiceSuggestionsStrip suggestions={SUGGESTIONS} onPick={onPick} />);

    fireEvent.click(screen.getByRole('button', { name: 'Any overdue invoices?' }));
    expect(onPick).toHaveBeenCalledWith('Any overdue invoices?');
    expect(onPick).toHaveBeenCalledTimes(1);
  });

  it('mobile contract: every chip is a ≥44px tap target (min-h-11) and does not shrink', () => {
    render(<VoiceSuggestionsStrip suggestions={SUGGESTIONS} onPick={() => {}} />);
    for (const text of SUGGESTIONS) {
      const chip = screen.getByRole('button', { name: text });
      expect(chip.className).toContain('min-h-11');
      expect(chip.className).toContain('shrink-0');
    }
  });

  it('mobile contract: the row scrolls internally (overflow-x-auto + min-w-0), never widening the bar', () => {
    render(<VoiceSuggestionsStrip suggestions={SUGGESTIONS} onPick={() => {}} />);
    const row = screen.getByTestId('voice-suggestions');
    expect(row.className).toContain('overflow-x-auto');
    expect(row.className).toContain('min-w-0');
  });

  it('renders nothing when there are no suggestions', () => {
    const { container } = render(<VoiceSuggestionsStrip suggestions={[]} onPick={() => {}} />);
    expect(container.firstChild).toBeNull();
  });
});
