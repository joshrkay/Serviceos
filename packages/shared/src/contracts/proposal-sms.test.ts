import { describe, it, expect } from 'vitest';
import {
  parseProposalSmsReply,
  APPROVE_TOKENS,
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

  it('classifies bulk approve: "ALL", "APPROVE ALL", "YES ALL" → approve_all (U5)', () => {
    for (const body of ['ALL', 'all', 'all!', 'APPROVE ALL', 'approve all', 'YES ALL', 'ok all']) {
      expect(parseProposalSmsReply(body).intent).toBe('approve_all');
    }
  });

  it('a single approve token without a trailing "all" stays a single approve', () => {
    expect(parseProposalSmsReply('approve').intent).toBe('approve');
    expect(parseProposalSmsReply('yes go ahead').intent).toBe('approve');
  });

  it('does not collide with other registered inbound keywords', () => {
    // STOP/START (compliance) and OUT/SICK/UNAVAILABLE (tech status) must
    // stay routable to their own handlers.
    for (const reserved of ['stop', 'start', 'out', 'sick', 'unavailable']) {
      expect(parseProposalSmsReply(reserved).intent).toBe('unrecognized');
    }
  });
});
