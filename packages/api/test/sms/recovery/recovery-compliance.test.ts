/**
 * P8-015 — recovery pre-send compliance gate (createRecoveryComplianceGate).
 *
 * Pins the customer-initiated SMS policy: DNC is the absolute block, an
 * explicit consent revoke for a known customer also blocks, and unknown /
 * granted / unset callers proceed (recovery must not over-suppress unknown
 * callers — they legitimately have no customer/consent record).
 */
import { describe, expect, it, vi } from 'vitest';
import { createRecoveryComplianceGate } from '../../../src/sms/recovery/recovery-compliance';
import type { DroppedCallRecoveryRow } from '../../../src/sms/recovery/scheduler';
import type { Customer } from '../../../src/customers/customer';

function row(): DroppedCallRecoveryRow {
  return {
    id: 'rec_1',
    tenantId: 'tenant-1',
    voiceSessionId: 'vs-1',
    callerE164: '+15551234567',
    scheduledFor: new Date('2026-07-07T00:00:00Z'),
    sentAt: null,
    suppressedReason: null,
    smsMessageSid: null,
    context: null,
    createdAt: new Date('2026-07-07T00:00:00Z'),
  };
}

function customer(consentStatus: Customer['consentStatus']): Customer {
  return { id: 'cust-1', consentStatus } as Customer;
}

describe('createRecoveryComplianceGate', () => {
  it('blocks a caller on the DNC list (opted_out) — the absolute floor', async () => {
    const gate = createRecoveryComplianceGate({
      dncRepo: { isOnDnc: vi.fn(async () => true) },
      customerRepo: { findByPhoneNormalized: vi.fn(async () => []) },
    });
    expect(await gate(row())).toBe('opted_out');
  });

  it('normalizes the phone to digits before the DNC lookup', async () => {
    const isOnDnc = vi.fn(async () => false);
    const gate = createRecoveryComplianceGate({
      dncRepo: { isOnDnc },
      customerRepo: { findByPhoneNormalized: vi.fn(async () => []) },
    });
    await gate(row());
    expect(isOnDnc).toHaveBeenCalledWith('tenant-1', '15551234567');
  });

  it('blocks a known customer who EXPLICITLY revoked consent (not on DNC)', async () => {
    const gate = createRecoveryComplianceGate({
      dncRepo: { isOnDnc: vi.fn(async () => false) },
      customerRepo: { findByPhoneNormalized: vi.fn(async () => [customer('revoked')]) },
    });
    expect(await gate(row())).toBe('opted_out');
  });

  it('blocks when ANY customer on a shared number revoked', async () => {
    const gate = createRecoveryComplianceGate({
      dncRepo: { isOnDnc: vi.fn(async () => false) },
      customerRepo: {
        findByPhoneNormalized: vi.fn(async () => [customer('granted'), customer('revoked')]),
      },
    });
    expect(await gate(row())).toBe('opted_out');
  });

  it('allows a known customer with granted consent', async () => {
    const gate = createRecoveryComplianceGate({
      dncRepo: { isOnDnc: vi.fn(async () => false) },
      customerRepo: { findByPhoneNormalized: vi.fn(async () => [customer('granted')]) },
    });
    expect(await gate(row())).toBeNull();
  });

  it('allows an UNKNOWN caller with no customer record (no over-suppression)', async () => {
    const gate = createRecoveryComplianceGate({
      dncRepo: { isOnDnc: vi.fn(async () => false) },
      customerRepo: { findByPhoneNormalized: vi.fn(async () => []) },
    });
    expect(await gate(row())).toBeNull();
  });

  it('never blocks on UNSET consent (undefined consentStatus)', async () => {
    const gate = createRecoveryComplianceGate({
      dncRepo: { isOnDnc: vi.fn(async () => false) },
      customerRepo: { findByPhoneNormalized: vi.fn(async () => [customer(undefined)]) },
    });
    expect(await gate(row())).toBeNull();
  });

  it('degrades to DNC-only when the repo has no findByPhoneNormalized', async () => {
    const gate = createRecoveryComplianceGate({
      dncRepo: { isOnDnc: vi.fn(async () => false) },
      customerRepo: {},
    });
    expect(await gate(row())).toBeNull();
  });
});
