import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import {
  inboundLeadSchema,
  INBOUND_LEAD_SOURCES,
  MAX_RAW_PAYLOAD_BYTES,
} from './lead.js';

const valid = {
  source: 'web_form' as const,
  firstName: 'Ada',
  primaryPhone: '5551234567',
};

describe('inboundLeadSchema', () => {
  it('parses a minimal valid web-form submission', () => {
    const parsed = inboundLeadSchema.parse(valid);
    expect(parsed.source).toBe('web_form');
    expect(parsed.firstName).toBe('Ada');
  });

  it('accepts company-only (no person name) with an email', () => {
    const parsed = inboundLeadSchema.parse({
      source: 'marketplace',
      companyName: 'Acme HVAC',
      email: 'ops@acme.example',
    });
    expect(parsed.companyName).toBe('Acme HVAC');
  });

  it('retains a verbatim raw payload', () => {
    const parsed = inboundLeadSchema.parse({
      ...valid,
      rawPayload: { form_id: 'contact-2', nested: { a: 1 } },
    });
    expect(parsed.rawPayload).toEqual({ form_id: 'contact-2', nested: { a: 1 } });
  });

  it('rejects an unknown source with a field-level error on `source`', () => {
    const result = inboundLeadSchema.safeParse({ ...valid, source: 'phone_call' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path[0] === 'source')).toBe(true);
    }
  });

  it('rejects a payload with neither name nor company (field path firstName)', () => {
    const result = inboundLeadSchema.safeParse({
      source: 'web_form',
      primaryPhone: '5551234567',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path[0] === 'firstName')).toBe(true);
    }
  });

  it('rejects a payload with no contact channel (field path primaryPhone)', () => {
    const result = inboundLeadSchema.safeParse({ source: 'web_form', firstName: 'Ada' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path[0] === 'primaryPhone')).toBe(true);
    }
  });

  it('rejects a malformed email with a field-level error on `email`', () => {
    const result = inboundLeadSchema.safeParse({
      source: 'web_form',
      firstName: 'Ada',
      email: 'not-an-email',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path[0] === 'email')).toBe(true);
    }
  });

  it('rejects an oversized raw payload', () => {
    const big = { blob: 'x'.repeat(MAX_RAW_PAYLOAD_BYTES + 1) };
    expect(() => inboundLeadSchema.parse({ ...valid, rawPayload: big })).toThrow(ZodError);
  });

  it('caps attribution at 20 entries', () => {
    const attribution: Record<string, string> = {};
    for (let i = 0; i < 21; i++) attribution[`k${i}`] = 'v';
    const result = inboundLeadSchema.safeParse({ ...valid, attribution });
    expect(result.success).toBe(false);
  });

  it('exposes exactly the externally-submittable source subset', () => {
    expect([...INBOUND_LEAD_SOURCES]).toEqual([
      'web_form',
      'marketplace',
      'referral',
      'other',
    ]);
  });
});
