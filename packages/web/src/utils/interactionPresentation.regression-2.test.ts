import { describe, expect, it } from 'vitest';
import { formatInteractionDuration } from './interactionPresentation';

// Regression: ISSUE-002 — interaction detail omitted durationSeconds and rendered "NaNs"
// Found by /qa on 2026-07-25
// Report: .gstack/qa-reports/qa-report-app-therivetapp-com-2026-07-25.md
describe('formatInteractionDuration', () => {
  it('formats valid durations without producing NaN output', () => {
    expect(formatInteractionDuration(29)).toBe('29s');
    expect(formatInteractionDuration(125)).toBe('2m 5s');
  });

  it('renders an em dash for missing or malformed durations', () => {
    expect(formatInteractionDuration(undefined)).toBe('—');
    expect(formatInteractionDuration(null)).toBe('—');
    expect(formatInteractionDuration(Number.NaN)).toBe('—');
  });
});
