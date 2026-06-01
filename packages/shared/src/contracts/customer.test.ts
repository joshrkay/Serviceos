import { describe, expect, it } from 'vitest';
import { customerSchema } from './customer.js';

const baseCustomer = {
  id: '11111111-1111-1111-1111-111111111111',
  tenantId: '22222222-2222-2222-2222-222222222222',
  firstName: 'Dana',
  lastName: 'Reyes',
  displayName: 'Dana Reyes',
  preferredChannel: 'text',
  smsConsent: true,
  isArchived: false,
  createdBy: 'user_abc',
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-06-01T00:00:00.000Z',
};

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
    expect(customerSchema.safeParse({ ...baseCustomer, preferredChannel: 'carrier_pigeon' }).success).toBe(false);
    expect(customerSchema.safeParse({ ...baseCustomer, accountType: 'b2b' }).success).toBe(true);
    expect(customerSchema.safeParse({ ...baseCustomer, accountType: 'enterprise' }).success).toBe(false);
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
