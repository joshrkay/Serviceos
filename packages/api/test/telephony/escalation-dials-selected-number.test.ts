import { describe, it, expect, vi } from 'vitest';
import { escalateToHuman } from '../../src/ai/skills/escalate-to-human';
import {
  createUserPhoneDispatcherResolver,
  createBusinessPhoneFallback,
} from '../../src/telephony/dispatcher-phone-resolver';
import { InMemoryUserRepository } from '../../src/users/user';
import type { SettingsRepository } from '../../src/settings/settings';

/**
 * Golden path for per-technician escalation routing: compose the REAL
 * dispatcher-phone-resolver (createUserPhoneDispatcherResolver) over a seeded
 * user repo with the REAL escalateToHuman + a callControl stub, and prove the
 * <Dial> rings the tradesperson's SELECTED number — and the shared business
 * line only when no on-call user has one.
 */
const TENANT = 'tenant-esc';

function callControlStub() {
  return {
    getCursor: vi.fn(() => ({ index: 0 })),
    setCursorAfter: vi.fn(),
    dialDispatcher: vi.fn(
      (_callSid: string, phone: string) => `<Response><Dial>${phone}</Dial></Response>`,
    ),
  };
}

function settingsStub(businessPhone?: string): SettingsRepository {
  return {
    findByTenant: vi.fn(async () => (businessPhone !== undefined ? { businessPhone } : null)),
  } as unknown as SettingsRepository;
}

async function seedTech(repo: InMemoryUserRepository, id: string, mobile?: string) {
  await repo.create!({
    id,
    tenantId: TENANT,
    email: `${id}@example.com`,
    role: 'technician',
    canFieldServe: true,
    clerkUserId: `clerk_${id}`,
  });
  if (mobile) await repo.setMobileNumber(TENANT, id, mobile);
}

describe("escalation dials the tradesperson's SELECTED number (golden)", () => {
  it("rings the on-call user's own mobile_number via the real resolver", async () => {
    const userRepo = new InMemoryUserRepository();
    await seedTech(userRepo, 'u-tech', '+15125550222');

    const onCallRepo = {
      listRotation: vi.fn(async () => [{ id: 'rot-1', userId: 'u-tech', cursorIndex: 0 }]),
    };
    const cc = callControlStub();

    const result = await escalateToHuman({
      tenantId: TENANT,
      sessionId: 'sess-1',
      reason: 'caller_requested',
      channel: 'telephony',
      callSid: 'CA-1',
      onCallRepo: onCallRepo as never,
      callControl: cc as never,
      dispatcherPhoneResolver: createUserPhoneDispatcherResolver(userRepo),
      businessPhoneFallbackResolver: createBusinessPhoneFallback(settingsStub('+15125550100')),
    });

    expect(result.escalated).toBe(true);
    expect(result.transfer?.dispatcherPhone).toBe('+15125550222');
    expect(cc.dialDispatcher).toHaveBeenCalledWith('CA-1', '+15125550222', expect.anything());
    expect(result.transfer?.fallbackTwiml).toContain('+15125550222');
  });

  it('falls back to business_phone when the on-call user has not set a number', async () => {
    const userRepo = new InMemoryUserRepository();
    await seedTech(userRepo, 'u-tech-no-phone'); // no mobile on file

    const onCallRepo = {
      listRotation: vi.fn(async () => [{ id: 'rot-1', userId: 'u-tech-no-phone', cursorIndex: 0 }]),
    };
    const cc = callControlStub();

    const result = await escalateToHuman({
      tenantId: TENANT,
      sessionId: 'sess-2',
      reason: 'caller_requested',
      channel: 'telephony',
      callSid: 'CA-2',
      onCallRepo: onCallRepo as never,
      callControl: cc as never,
      dispatcherPhoneResolver: createUserPhoneDispatcherResolver(userRepo),
      businessPhoneFallbackResolver: createBusinessPhoneFallback(settingsStub('+15125550100')),
    });

    expect(result.escalated).toBe(true);
    expect(result.transfer?.dispatcherPhone).toBe('+15125550100');
    expect(cc.dialDispatcher).toHaveBeenCalledWith('CA-2', '+15125550100', expect.anything());
  });
});
