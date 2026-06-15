import { describe, it, expect } from 'vitest';
import {
  parseProposalSmsReply,
  APPROVE_TOKENS,
  APPROVE_ALL_TOKENS,
  REJECT_TOKENS,
  EDIT_TOKENS,
} from './proposal-sms.js';

describe('parseProposalSmsReply (P2-034)', () => {
  it.each([...APPROVE_TOKENS])('approves on token %s', (token) => {
    expect(parseProposalSmsReply(token).intent).toBe('approve');
  });

  it.each([...REJECT_TOKENS])('rejects on token %s', (token) => {
    expect(parseProposalSmsReply(token).intent).toBe('reject');
  });

  it.each([...EDIT_TOKENS])('opens edit on token %s', (token) => {
    expect(parseProposalSmsReply(token).intent).toBe('edit');
  });

  it('is tolerant of capitalization, whitespace and punctuation', () => {
    expect(parseProposalSmsReply('  YES ').intent).toBe('approve');
    expect(parseProposalSmsReply('Yes!').intent).toBe('approve');
    expect(parseProposalSmsReply('"OK"').intent).toBe('approve');
    expect(parseProposalSmsReply('\nApprove.').intent).toBe('approve');
    expect(parseProposalSmsReply('NO.').intent).toBe('reject');
    expect(parseProposalSmsReply(' Edit ').intent).toBe('edit');
  });

  it('captures the remainder as the rejection reason', () => {
    const r = parseProposalSmsReply('N price is too high');
    expect(r.intent).toBe('reject');
    expect(r.remainder).toBe('price is too high');
  });

  it('captures the remainder after approve tokens', () => {
    const r = parseProposalSmsReply('yes go ahead');
    expect(r.intent).toBe('approve');
    expect(r.remainder).toBe('go ahead');
  });

  it('returns unrecognized with the full trimmed body otherwise', () => {
    const r = parseProposalSmsReply('  make it $200 instead ');
    expect(r.intent).toBe('unrecognized');
    expect(r.remainder).toBe('make it $200 instead');
  });

  it('handles empty and whitespace-only bodies without throwing', () => {
    expect(parseProposalSmsReply('')).toEqual({ intent: 'unrecognized', remainder: '' });
    expect(parseProposalSmsReply('   ')).toEqual({ intent: 'unrecognized', remainder: '' });
  });

  it('does not collide with other registered inbound keywords', () => {
    // STOP/START (compliance) and OUT/SICK/UNAVAILABLE (tech status) must
    // stay routable to their own handlers.
    for (const reserved of ['stop', 'start', 'out', 'sick', 'unavailable']) {
      expect(parseProposalSmsReply(reserved).intent).toBe('unrecognized');
    }
  });

  describe('U5 (JTBD #7) — APPROVE ALL', () => {
    it.each([...APPROVE_ALL_TOKENS])('classifies bare token %s as approve_all', (token) => {
      expect(parseProposalSmsReply(token).intent).toBe('approve_all');
    });

    it('classifies the composite "APPROVE ALL" as approve_all', () => {
      expect(parseProposalSmsReply('APPROVE ALL').intent).toBe('approve_all');
      expect(parseProposalSmsReply('approve everything').intent).toBe('approve_all');
      expect(parseProposalSmsReply('  Yes, all! ').intent).toBe('approve_all');
    });

    it('is tolerant of capitalization, whitespace and punctuation', () => {
      expect(parseProposalSmsReply(' ALL ').intent).toBe('approve_all');
      expect(parseProposalSmsReply('All.').intent).toBe('approve_all');
      expect(parseProposalSmsReply('"everything"').intent).toBe('approve_all');
    });

    it('does NOT downgrade plain approve replies', () => {
      // A bare approve token, or one followed by non-ALL text, stays `approve`.
      expect(parseProposalSmsReply('yes').intent).toBe('approve');
      expect(parseProposalSmsReply('approve').intent).toBe('approve');
      expect(parseProposalSmsReply('yes go ahead').intent).toBe('approve');
      expect(parseProposalSmsReply('approve this one').intent).toBe('approve');
    });

    it('drops the consumed ALL token from the remainder', () => {
      const r = parseProposalSmsReply('approve all of them');
      expect(r.intent).toBe('approve_all');
      expect(r.remainder).toBe('of them');
    });
  });
});
