import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { VoiceSuggestionsStrip } from './VoiceSuggestionsStrip';

describe('VoiceSuggestionsStrip layout contract', () => {
  it('renders min-h-11 suggestion buttons in a minmax grid container', () => {
    const onSelect = vi.fn();
    const { container } = render(
      <VoiceSuggestionsStrip
        suggestions={[
          { text: 'Show schedule' },
          { text: 'Invoice Acme' },
        ]}
        onSelect={onSelect}
      />,
    );

    const strip = screen.getByTestId('voice-suggestions-strip');
    expect(strip.className).toContain('min-w-0');
    expect(strip.getAttribute('style')).toContain('minmax(0, 1fr)');

    const buttons = container.querySelectorAll('button');
    expect(buttons.length).toBe(2);
    buttons.forEach((btn) => {
      expect(btn.className).toContain('min-h-11');
      expect(btn.className).toContain('min-w-0');
    });

    fireEvent.click(buttons[0]);
    expect(onSelect).toHaveBeenCalledWith('Show schedule');
  });
});
