import { describe, expect, it } from 'vitest';
import { getEstimateTotalCents } from './estimateMoney';

// Regression: ISSUE-001 — dashboard read a flat estimate total and rendered $NaN
// Found by /qa on 2026-07-25
// Report: .gstack/qa-reports/qa-report-app-therivetapp-com-2026-07-25.md
describe('getEstimateTotalCents', () => {
  it('reads the nested total used by the estimates API', () => {
    expect(getEstimateTotalCents({ totals: { totalCents: 17_800 } })).toBe(17_800);
  });

  it('keeps compatibility with legacy flat estimate totals', () => {
    expect(getEstimateTotalCents({ totalCents: 17_800 })).toBe(17_800);
  });

  it('refuses malformed money instead of allowing a NaN display', () => {
    expect(getEstimateTotalCents({})).toBeNull();
    expect(getEstimateTotalCents({ totals: { totalCents: '17800' } })).toBeNull();
    expect(getEstimateTotalCents({ totals: { totalCents: Number.NaN } })).toBeNull();
  });
});
