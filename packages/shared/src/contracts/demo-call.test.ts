import { describe, it, expect } from 'vitest';
import {
  DEMO_CALL_TRADES,
  DemoCallStartInputSchema,
  DemoCallStartResponseSchema,
  DemoCallErrorSchema,
} from './demo-call.js';

describe('DemoCallStartInputSchema', () => {
  const ok = { phone: '(512) 555-0142', trade: 'plumbing', businessName: '  Austin Pipe Pros ' };

  it('accepts a phone, a listed trade and a business name, trimming the name', () => {
    expect(DemoCallStartInputSchema.parse(ok)).toEqual({
      phone: '(512) 555-0142',
      trade: 'plumbing',
      businessName: 'Austin Pipe Pros',
    });
    expect(DemoCallStartInputSchema.parse({ ...ok, metro: 'austin' }).metro).toBe('austin');
  });

  it('the trades are the four packs', () => {
    expect([...DEMO_CALL_TRADES]).toEqual(['plumbing', 'hvac', 'electrical', 'painting']);
  });

  it.each([
    ['an unlisted trade', { ...ok, trade: 'roofing' }],
    ['a blank business name', { ...ok, businessName: '   ' }],
    ['a business name over 80 characters', { ...ok, businessName: 'x'.repeat(81) }],
    ['a short phone', { ...ok, phone: '12345' }],
    ['a long phone', { ...ok, phone: '1'.repeat(21) }],
    ['a missing phone', { trade: 'plumbing', businessName: 'A' }],
    ['an unknown field', { ...ok, extra: true }],
    ['a long metro', { ...ok, metro: 'm'.repeat(65) }],
  ])('rejects %s', (_label, input) => {
    expect(DemoCallStartInputSchema.safeParse(input).success).toBe(false);
  });
});

describe('demo call responses', () => {
  it('a started call answers its correlation id and calling', () => {
    expect(DemoCallStartResponseSchema.parse({ correlationId: 'abc', status: 'calling' })).toEqual({
      correlationId: 'abc',
      status: 'calling',
    });
    expect(DemoCallStartResponseSchema.safeParse({ correlationId: 'abc', status: 'unconfirmed' }).success).toBe(false);
  });

  it('errors carry a code and plain words', () => {
    for (const error of ['DEMO_DISABLED', 'DEMO_DAILY_LIMIT', 'DEMO_BUSY', 'DEMO_NUMBER_NOT_ALLOWED', 'DEMO_CALL_FAILED', 'INVALID_INPUT']) {
      expect(DemoCallErrorSchema.parse({ error, message: 'x' }).error).toBe(error);
    }
    expect(DemoCallErrorSchema.safeParse({ error: 'OTHER', message: 'x' }).success).toBe(false);
  });
});
