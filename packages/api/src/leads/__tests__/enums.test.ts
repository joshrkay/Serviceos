// P12-005 — placeholder. Real assertions live in
// `packages/api/test/leads/enums.test.ts` per repo convention (the
// `test/` tree is the home for executed enum/contract tests; this
// `__tests__/` placeholder exists so dispatch-allowed file lists
// stay aligned with the eventual co-located pattern).
import { describe, it, expect } from 'vitest';
import { LEAD_SOURCES, leadSourceSchema } from '../enums';

describe('Leads — enums (P12-005 placeholder)', () => {
  it('LEAD_SOURCES is a non-empty readonly tuple', () => {
    expect(LEAD_SOURCES.length).toBeGreaterThan(0);
  });
  it('leadSourceSchema is exported', () => {
    expect(typeof leadSourceSchema.parse).toBe('function');
  });
});
