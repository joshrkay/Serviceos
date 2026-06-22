import { describe, it, expect } from 'vitest';
import { useVoiceSuggestions } from './useVoiceSuggestions';

describe('useVoiceSuggestions', () => {
  it('returns schedule-relevant utterances on /schedule', () => {
    const items = useVoiceSuggestions('/schedule');
    expect(items).toHaveLength(3);
    expect(items[0].text.toLowerCase()).toContain('thursday');
  });

  it('returns a different set on /invoices', () => {
    const items = useVoiceSuggestions('/invoices');
    expect(items.some((s) => s.text.toLowerCase().includes('invoice'))).toBe(true);
    expect(items.some((s) => s.text.toLowerCase().includes('thursday'))).toBe(false);
  });
});
