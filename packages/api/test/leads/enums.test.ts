// P12-005 — LEAD_SOURCES enum extension.
//
// Locks in the new `customer_portal` source value across:
//   1. the runtime tuple (used by validation in routes/leads.ts)
//   2. the Zod schema (used by createLeadSchema / updateLeadSchema)
//   3. back-compat for the original 6 values
import { describe, it, expect } from 'vitest';
import {
  LEAD_SOURCES,
  leadSourceSchema,
  createLeadSchema,
  updateLeadSchema,
} from '../../src/leads/enums';

describe('Leads — LEAD_SOURCES enum (P12-005 customer_portal lead source)', () => {
  it('AC-1: includes customer_portal as the 7th value', () => {
    expect(LEAD_SOURCES.length).toBe(7);
    expect(LEAD_SOURCES[6]).toBe('customer_portal');
    expect(LEAD_SOURCES).toContain('customer_portal');
  });

  it('AC-5: keeps the original 6 source values for back-compat', () => {
    for (const v of [
      'web_form',
      'phone_call',
      'referral',
      'walk_in',
      'marketplace',
      'other',
    ]) {
      expect(LEAD_SOURCES).toContain(v);
    }
  });

  it('AC-2: leadSourceSchema (Zod) accepts customer_portal', () => {
    expect(() => leadSourceSchema.parse('customer_portal')).not.toThrow();
  });

  it('leadSourceSchema rejects unknown values', () => {
    expect(() => leadSourceSchema.parse('not_a_real_source')).toThrow();
  });

  it('createLeadSchema accepts customer_portal as a lead source', () => {
    const parsed = createLeadSchema.parse({
      firstName: 'Carla',
      source: 'customer_portal',
      email: 'carla@example.com',
    });
    expect(parsed.source).toBe('customer_portal');
  });

  it('updateLeadSchema accepts customer_portal as a lead source update', () => {
    const parsed = updateLeadSchema.parse({ source: 'customer_portal' });
    expect(parsed.source).toBe('customer_portal');
  });
});
