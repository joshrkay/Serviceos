import { describe, it, expect } from 'vitest';
import {
  applyCreditCap,
  creditTierForReview,
  CREDIT_CAP_CENTS_PER_12_MONTHS,
} from '../../src/reputation/credit-tier';

describe('P7-026 credit-tier', () => {
  describe('creditTierForReview — tier matrix', () => {
    it('praise always returns 0 regardless of rating', () => {
      for (const rating of [1, 2, 3, 4, 5]) {
        expect(creditTierForReview('praise', rating)).toBe(0);
      }
    });

    it('specific_complaint: 1★ → $100, 2★ → $50, 3-5★ → $25', () => {
      expect(creditTierForReview('specific_complaint', 1)).toBe(10000);
      expect(creditTierForReview('specific_complaint', 2)).toBe(5000);
      expect(creditTierForReview('specific_complaint', 3)).toBe(2500);
      expect(creditTierForReview('specific_complaint', 4)).toBe(2500);
      expect(creditTierForReview('specific_complaint', 5)).toBe(2500);
    });

    it('vague_complaint: 1★ → $50, 2★ → $25, 3-5★ → 0', () => {
      expect(creditTierForReview('vague_complaint', 1)).toBe(5000);
      expect(creditTierForReview('vague_complaint', 2)).toBe(2500);
      expect(creditTierForReview('vague_complaint', 3)).toBe(0);
      expect(creditTierForReview('vague_complaint', 4)).toBe(0);
      expect(creditTierForReview('vague_complaint', 5)).toBe(0);
    });

    it('out-of-range ratings fall through to 0 (safe default)', () => {
      expect(creditTierForReview('specific_complaint', 0)).toBe(0);
      expect(creditTierForReview('specific_complaint', 6)).toBe(0);
    });
  });

  describe('applyCreditCap', () => {
    it('returns request unchanged when room remains', () => {
      expect(applyCreditCap(2500, 7500)).toBe(2500);
      expect(applyCreditCap(5000, 0)).toBe(5000);
    });

    it('allows EXACTLY hitting the cap (boundary inclusive)', () => {
      expect(applyCreditCap(10000, 0)).toBe(10000);
      expect(applyCreditCap(2500, 7500)).toBe(2500);
    });

    it('returns 0 when overflow would occur', () => {
      expect(applyCreditCap(2500, 9000)).toBe(0);
      expect(applyCreditCap(10000, 1)).toBe(0);
      expect(applyCreditCap(5000, 8000)).toBe(0);
    });

    it('returns 0 when request itself is 0 (avoids vacuous-credit suggestions)', () => {
      expect(applyCreditCap(0, 0)).toBe(0);
      expect(applyCreditCap(0, 5000)).toBe(0);
    });

    it('cap constant is $100 (10000 cents)', () => {
      expect(CREDIT_CAP_CENTS_PER_12_MONTHS).toBe(10000);
    });
  });
});
