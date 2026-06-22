import { describe, it, expect } from 'vitest';
import { resolveSmsConsentForOutbound } from '../../src/compliance/sms-consent-gate';
import type { ConsentEventRow } from '../../src/compliance/consent-events';
import type { Customer } from '../../src/customers/customer';

function makeCustomer(overrides: Partial<Customer> = {}): Customer {
  return {
    id: 'c1',
    tenantId: 't1',
    firstName: 'Sam',
    lastName: 'Lee',
    displayName: 'Sam Lee',
    primaryPhone: '+15551234567',
    preferredChannel: 'sms',
    smsConsent: true,
    isArchived: false,
    createdBy: 'u1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function ledgerRow(state: 'granted' | 'revoked'): ConsentEventRow {
  return {
    id: 'e1',
    tenantId: 't1',
    customerId: 'c1',
    phoneNormalized: '15551234567',
    kind: 'sms',
    state,
    source: 'portal',
    voiceSessionId: null,
    createdAt: new Date(),
  };
}

describe('resolveSmsConsentForOutbound', () => {
  it('allows when boolean consent is true', () => {
    expect(resolveSmsConsentForOutbound(makeCustomer(), []).allowed).toBe(true);
  });

  it('blocks when ledger shows revoked even if boolean is true', () => {
    const result = resolveSmsConsentForOutbound(makeCustomer(), [ledgerRow('revoked')]);
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toBe('consent_revoked');
  });

  it('allows when ledger grants despite boolean false', () => {
    expect(
      resolveSmsConsentForOutbound(makeCustomer({ smsConsent: false }), [ledgerRow('granted')]).allowed,
    ).toBe(true);
  });

  it('blocks when neither boolean nor ledger grants', () => {
    const result = resolveSmsConsentForOutbound(makeCustomer({ smsConsent: false }), []);
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toBe('no_consent');
  });
});
