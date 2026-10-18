import { describe, it, expect } from 'vitest';
import { ApproveDraftBodySchema, StageChoiceBodySchema } from '../../../src/onboarding/draft/contracts';

describe('ApproveDraftBodySchema', () => {
  it.each([[{}], [{ expectedVersion: 1 }], [{ expectedVersion: 7 }]])('accepts %j', (body) => {
    expect(ApproveDraftBodySchema.safeParse(body).success).toBe(true);
  });

  it.each([[0], [-1], [1.5], ['3'], [null], [Number.NaN]])('rejects expectedVersion %j', (expectedVersion) => {
    expect(ApproveDraftBodySchema.safeParse({ expectedVersion }).success).toBe(false);
  });

  it('rejects an unknown key (strict)', () => {
    expect(ApproveDraftBodySchema.safeParse({ expectedVersion: 1, extra: true }).success).toBe(false);
    expect(ApproveDraftBodySchema.safeParse({ bogus: 1 }).success).toBe(false);
  });

  it('does not change StageChoiceBodySchema: its version stays required', () => {
    expect(StageChoiceBodySchema.safeParse({ choice: { option: 'a' } }).success).toBe(false);
    expect(StageChoiceBodySchema.safeParse({ choice: { option: 'a' }, version: 1 }).success).toBe(true);
  });
});
