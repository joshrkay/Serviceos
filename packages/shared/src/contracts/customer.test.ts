import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { PreferredChannel } from '../enums.js';
import { customerSchema, preferredChannelSchema, customerListItemSchema } from './customer.js';
import { resolveDbCheckSet } from './db-check.js';

const schemaSource = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../../api/src/db/schema.ts'),
  'utf8',
);

const baseCustomer = {
  id: '11111111-1111-1111-1111-111111111111',
  tenantId: '22222222-2222-2222-2222-222222222222',
  firstName: 'Dana',
  lastName: 'Reyes',
  displayName: 'Dana Reyes',
  preferredChannel: 'sms',
  smsConsent: true,
  isArchived: false,
  createdBy: 'user_abc',
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-06-01T00:00:00.000Z',
};

describe('customerListItemSchema', () => {
  it('validates a plain customer entity (no list enrichments)', () => {
    expect(customerListItemSchema.safeParse(baseCustomer).success).toBe(true);
  });

  it('accepts optional list enrichments (open jobs, tags, locations)', () => {
    const parsed = customerListItemSchema.parse({
      ...baseCustomer,
      openJobs: 2,
      tags: ['VIP'],
      lastService: '2026-05-01',
      locations: [{ id: 'loc-1', street1: '123 Main St', serviceTypes: ['HVAC'] }],
    });
    expect(parsed.openJobs).toBe(2);
    expect(parsed.locations?.[0].serviceTypes).toEqual(['HVAC']);
  });
});

describe('customerSchema', () => {
  it('parses a representative customer payload', () => {
    expect(customerSchema.parse(baseCustomer).displayName).toBe('Dana Reyes');
  });

  it('requires the core identity fields', () => {
    const { displayName, ...withoutDisplay } = baseCustomer;
    void displayName;
    expect(customerSchema.safeParse(withoutDisplay).success).toBe(false);
  });

  it('constrains preferredChannel and accountType to known values', () => {
    // 'text' was the old (wrong) shared-enum value; the DB uses 'sms' / 'none'.
    expect(customerSchema.safeParse({ ...baseCustomer, preferredChannel: 'text' }).success).toBe(false);
    expect(customerSchema.safeParse({ ...baseCustomer, preferredChannel: 'none' }).success).toBe(true);
    expect(customerSchema.safeParse({ ...baseCustomer, preferredChannel: 'carrier_pigeon' }).success).toBe(false);
    expect(customerSchema.safeParse({ ...baseCustomer, accountType: 'b2b' }).success).toBe(true);
    expect(customerSchema.safeParse({ ...baseCustomer, accountType: 'property_manager' }).success).toBe(true);
    expect(customerSchema.safeParse({ ...baseCustomer, accountType: 'enterprise' }).success).toBe(false);
    expect(
      customerSchema.safeParse({ ...baseCustomer, parentAccountId: '44444444-4444-4444-4444-444444444444' }).success,
    ).toBe(true);
  });

  it('preferredChannelSchema matches the PreferredChannel enum and the DB CHECK', () => {
    expect([...preferredChannelSchema.options].sort()).toEqual([...Object.values(PreferredChannel)].sort());
    const dbSet = resolveDbCheckSet(schemaSource, 'customers', 'preferred_channel');
    expect([...preferredChannelSchema.options].sort()).toEqual([...dbSet].sort());
  });

  it('accepts optional communication + attribution fields', () => {
    const parsed = customerSchema.parse({
      ...baseCustomer,
      companyName: 'Acme Co',
      secondaryPhone: '+15035551212',
      communicationNotes: 'Prefers texts after 5pm',
      originatingLeadId: '33333333-3333-3333-3333-333333333333',
    });
    expect(parsed.companyName).toBe('Acme Co');
  });
});
