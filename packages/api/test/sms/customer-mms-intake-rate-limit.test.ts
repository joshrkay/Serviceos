/**
 * U6 — customer MMS cost/abuse gate (unit; mocked deps).
 *
 * Proves the intake honors `checkRateLimit` BEFORE resolving/creating a
 * customer or calling the vision model: an over-limit sender produces no
 * proposal, no customer, and no LLM spend.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  ingestCustomerMms,
  type CustomerMmsIntakeDeps,
} from '../../src/sms/customer-mms/customer-mms-intake';
import type { InboundSmsContext } from '../../src/sms/inbound-dispatch';
import type { Customer } from '../../src/customers/customer';

const TENANT = 'tenant-1';
const PHONE = '+15125559999';

function makeCtx(): InboundSmsContext {
  return {
    tenantId: TENANT,
    fromE164: PHONE,
    body: 'quote this',
    messageSid: 'SM-rl-1',
    media: [{ url: 'https://api.twilio.com/media/RL1', contentType: 'image/jpeg' }],
  };
}

function baseDeps(over: Partial<CustomerMmsIntakeDeps>): {
  deps: CustomerMmsIntakeDeps;
  gatewayComplete: ReturnType<typeof vi.fn>;
  proposalCreate: ReturnType<typeof vi.fn>;
  findByPhoneNormalized: ReturnType<typeof vi.fn>;
} {
  const gatewayComplete = vi.fn();
  const proposalCreate = vi.fn(async (p: unknown) => p);
  const findByPhoneNormalized = vi.fn(async () => [] as Customer[]);
  const deps = {
    customerRepo: { findByPhoneNormalized } as unknown as CustomerMmsIntakeDeps['customerRepo'],
    proposalRepo: { create: proposalCreate },
    fileRepo: { create: vi.fn() },
    storage: { putObject: vi.fn(), generateDownloadUrl: vi.fn() },
    storageBucket: 'b',
    fetchMedia: vi.fn(),
    gateway: { complete: gatewayComplete } as unknown as CustomerMmsIntakeDeps['gateway'],
    ...over,
  } as unknown as CustomerMmsIntakeDeps;
  return { deps, gatewayComplete, proposalCreate, findByPhoneNormalized };
}

describe('U6 — customer MMS rate limiting', () => {
  it('over the cap → rate_limited; no resolution, no vision call, no write', async () => {
    const checkRateLimit = vi.fn(async () => false);
    const { deps, gatewayComplete, proposalCreate, findByPhoneNormalized } = baseDeps({
      checkRateLimit,
    });

    const result = await ingestCustomerMms(makeCtx(), deps);

    expect(result.outcome).toBe('rate_limited');
    expect(checkRateLimit).toHaveBeenCalledWith(TENANT, PHONE);
    // Short-circuits BEFORE customer resolution, vision call, or any write.
    expect(findByPhoneNormalized).not.toHaveBeenCalled();
    expect(gatewayComplete).not.toHaveBeenCalled();
    expect(proposalCreate).not.toHaveBeenCalled();
  });

  it('within the cap → proceeds past the gate into customer resolution', async () => {
    const checkRateLimit = vi.fn(async () => true);
    // Two matches on the sender phone → ambiguous → clarification (no vision
    // call), which proves we passed the gate and ran resolution.
    const matches = [
      { id: 'c1', displayName: 'A', isArchived: false, primaryPhone: PHONE },
      { id: 'c2', displayName: 'B', isArchived: false, primaryPhone: PHONE },
    ] as unknown as Customer[];
    const findByPhoneNormalized = vi.fn(async () => matches);
    const { deps, gatewayComplete } = baseDeps({
      checkRateLimit,
      customerRepo: {
        findByPhoneNormalized,
      } as unknown as CustomerMmsIntakeDeps['customerRepo'],
    });

    const result = await ingestCustomerMms(makeCtx(), deps);

    expect(checkRateLimit).toHaveBeenCalled();
    expect(result.outcome).toBe('clarification');
    expect(gatewayComplete).not.toHaveBeenCalled();
  });
});
