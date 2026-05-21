import { describe, it, expect, vi } from 'vitest';
import {
  patchToOwnerCell,
  handleOwnerDialResult,
  composeOwnerFallbackSms,
  OWNER_DIAL_TIMEOUT_SECONDS,
  type OwnerPatchDeps,
  type OwnerPatchInput,
} from '../../../src/voice/triage/owner-cell-patch';
import { DefaultTwilioCallControl } from '../../../src/telephony/twilio-call-control';
import type { TriageDecision, VulnerabilitySignal } from '@ai-service-os/shared';

const signals: VulnerabilitySignal[] = [
  { kind: 'medical', evidence: 'caller mentioned oxygen', weight: 1 },
  { kind: 'age', evidence: 'age >65 on record', weight: 1 },
];

const patchDecision: TriageDecision = {
  kind: 'patch_owner',
  reason: 'vulnerability (score 2) with critical urgency',
  urgency: 'critical',
  score: { signals, total: 2, weatherUnavailable: false },
};

function makeDeps(overrides: Partial<OwnerPatchDeps> = {}): {
  deps: OwnerPatchDeps;
  createBooking: ReturnType<typeof vi.fn>;
  sendSms: ReturnType<typeof vi.fn>;
} {
  const createBooking = vi.fn(async () => ({ proposalId: 'prop-1' }));
  const sendSms = vi.fn(async () => ({ sid: 'sm-1' }));
  const deps: OwnerPatchDeps = {
    ownerPhoneResolver: async () => '+15125550100',
    callControl: new DefaultTwilioCallControl(),
    createHighPriorityBooking: createBooking,
    sendSms,
    ...overrides,
  };
  return { deps, createBooking, sendSms };
}

function makeInput(overrides: Partial<OwnerPatchInput> = {}): OwnerPatchInput {
  return {
    tenantId: 't-1',
    voiceSessionId: 'vs-1',
    callSid: 'CA123',
    dialActionUrl: '/api/telephony/owner-dial-result?sid=vs-1',
    decision: patchDecision,
    customerId: 'cust-1',
    prefaceCustomer: { firstName: 'Maria', customerSinceYear: 2024 },
    ...overrides,
  };
}

describe('P8-016 owner-cell-patch', () => {
  it('patches owner cell with a 60s dial timeout + deterministic preface', async () => {
    const { deps } = makeDeps();
    const result = await patchToOwnerCell(makeInput(), deps);
    expect(result.kind).toBe('patched');
    if (result.kind !== 'patched') return;
    expect(result.ownerPhone).toBe('+15125550100');
    expect(result.twiml).toContain(`timeout="${OWNER_DIAL_TIMEOUT_SECONDS}"`);
    expect(result.twiml).toContain('+15125550100');
    expect(result.preface).toContain('Putting them through.');
  });

  it('falls back to high-priority booking + owner SMS when owner unreachable for 60s', async () => {
    const { deps, createBooking, sendSms } = makeDeps();
    const result = await handleOwnerDialResult(makeInput(), deps, 'no-answer', '+15125550100');
    expect(result).not.toBeNull();
    expect(result!.kind).toBe('fallback');
    if (result!.kind !== 'fallback') return;
    expect(result!.fallbackReason).toBe('owner_unreachable');
    expect(result!.proposalId).toBe('prop-1');
    expect(result!.ownerNotified).toBe(true);
    expect(createBooking).toHaveBeenCalledOnce();
    expect(sendSms).toHaveBeenCalledOnce();
    // Booking carries the vulnerability metadata in sourceContext.
    const bookingArg = createBooking.mock.calls[0][0];
    expect(bookingArg.sourceContext.signals).toEqual(signals);
    expect(bookingArg.sourceContext.fallbackReason).toBe('owner_unreachable');
  });

  it('answered/completed dial → no fallback', async () => {
    const { deps } = makeDeps();
    const result = await handleOwnerDialResult(makeInput(), deps, 'completed', '+15125550100');
    expect(result).toBeNull();
  });

  it('no owner number on file → fallback booking, no SMS', async () => {
    const { deps, createBooking, sendSms } = makeDeps({
      ownerPhoneResolver: async () => null,
    });
    const result = await patchToOwnerCell(makeInput(), deps);
    expect(result.kind).toBe('fallback');
    if (result.kind !== 'fallback') return;
    expect(result.fallbackReason).toBe('no_owner_number');
    expect(result.ownerNotified).toBe(false);
    expect(createBooking).toHaveBeenCalledOnce();
    expect(sendSms).not.toHaveBeenCalled();
  });

  it('owner fallback SMS is non-PII and non-clinical', () => {
    const sms = composeOwnerFallbackSms(patchDecision);
    expect(sms).toMatch(/Priority call/i);
    expect(sms).not.toMatch(/@|\d{3}[-.]\d{3}[-.]\d{4}/); // no email/phone
    expect(sms).not.toMatch(/you have a medical emergency|diagnos/i);
  });

  it('rejects a non-patch decision', async () => {
    const { deps } = makeDeps();
    await expect(
      patchToOwnerCell(
        makeInput({ decision: { ...patchDecision, kind: 'normal' } }),
        deps,
      ),
    ).rejects.toThrow(/patch_owner/);
  });
});
