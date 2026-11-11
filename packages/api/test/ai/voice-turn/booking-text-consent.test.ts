/**
 * `decideBookingTextConsent` — would the booking-confirmation text go out for
 * this caller, and if not, may we ask? It reuses `resolveOutboundConsent`, the
 * same decision core the customer-SMS gate (block mode) applies, so the spoken
 * promise cannot drift from what the gate then does.
 *
 * Value: protects=the "I'll text you" promise is made only when the gate will let the text through, and a caller who can still consent is asked rather than silently skipped;
 *   fails_when=the decision reads only customers.sms_consent (ignoring DNC or a standing revocation), asks a DNC caller, or throws on a repo failure instead of withholding the promise;
 *   why_new=no consent check existed before the booking confirmation line;
 *   seam=none;
 *   no_claim=how the answer is captured (inbound-booking-sms-consent.test.ts)
 */
import { describe, it, expect, vi } from 'vitest';
import { decideBookingTextConsent } from '../../../src/ai/voice-turn/booking-text-consent';
import { InMemoryCustomerRepository, type Customer } from '../../../src/customers/customer';
import { InMemoryConsentEventRepository } from '../../../src/compliance/consent-events';
import { InMemoryDncRepository, normalizePhone } from '../../../src/compliance/dnc';

const TENANT = 'tenant-booking-text-consent';
const OTHER_TENANT = 'tenant-someone-else';
const CUSTOMER_ID = '22222222-3333-4444-5555-666666666666';
const PHONE = '+15125550100';

function customer(smsConsent: boolean): Customer {
  return {
    id: CUSTOMER_ID,
    tenantId: TENANT,
    firstName: 'Dana',
    lastName: 'Lee',
    displayName: 'Dana Lee',
    primaryPhone: PHONE,
    smsConsent,
    preferredChannel: 'sms',
    isArchived: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as Customer;
}

async function setup(opts: { smsConsent: boolean }) {
  const customerRepo = new InMemoryCustomerRepository();
  await customerRepo.create(customer(opts.smsConsent));
  const consentEventRepo = new InMemoryConsentEventRepository();
  const dncRepo = new InMemoryDncRepository();
  return { customerRepo, consentEventRepo, dncRepo };
}

const input = { tenantId: TENANT, customerId: CUSTOMER_ID, phone: PHONE, canAsk: true };

describe('decideBookingTextConsent', () => {
  it('consent on file, no DNC, no revocation: promise the text, no question', async () => {
    const deps = await setup({ smsConsent: true });
    await expect(decideBookingTextConsent(deps, input)).resolves.toEqual({
      action: 'promise',
      reason: 'on_file',
    });
  });

  it('no consent on file: ask', async () => {
    const deps = await setup({ smsConsent: false });
    await expect(decideBookingTextConsent(deps, input)).resolves.toEqual({
      action: 'ask',
      reason: 'needs_consent',
    });
  });

  it('no consent on file but this transport cannot take the answer: no promise, no question', async () => {
    const deps = await setup({ smsConsent: false });
    await expect(
      decideBookingTextConsent(deps, { ...input, canAsk: false }),
    ).resolves.toEqual({ action: 'no_promise', reason: 'cannot_ask' });
  });

  it.each([true, false])('caller on the DNC list (sms_consent=%s): never asked, never promised', async (smsConsent) => {
    const deps = await setup({ smsConsent });
    deps.dncRepo.add(TENANT, normalizePhone(PHONE));
    await expect(decideBookingTextConsent(deps, input)).resolves.toEqual({
      action: 'no_promise',
      reason: 'dnc',
    });
  });

  it("another tenant's DNC entry for the same number does not block this tenant", async () => {
    const deps = await setup({ smsConsent: true });
    deps.dncRepo.add(OTHER_TENANT, normalizePhone(PHONE));
    await expect(decideBookingTextConsent(deps, input)).resolves.toMatchObject({
      action: 'promise',
    });
  });

  it('standing sms revocation in the ledger beats a stale sms_consent=true: no promise, no question', async () => {
    const deps = await setup({ smsConsent: true });
    await deps.consentEventRepo.append({
      tenantId: TENANT,
      customerId: CUSTOMER_ID,
      phone: PHONE,
      kind: 'sms',
      state: 'revoked',
      source: 'sms',
    });
    await expect(decideBookingTextConsent(deps, input)).resolves.toEqual({
      action: 'no_promise',
      reason: 'revoked',
    });
  });

  it.each([
    ['no customer id (unidentified caller)', { customerId: undefined }],
    ['no caller phone', { phone: undefined }],
  ])('%s: cannot verify the gate, so no promise and no question', async (_label, patch) => {
    const deps = await setup({ smsConsent: true });
    await expect(
      decideBookingTextConsent(deps, { ...input, ...patch }),
    ).resolves.toEqual({ action: 'no_promise', reason: 'unverifiable' });
  });

  it('customer not found for this tenant: unverifiable', async () => {
    const deps = await setup({ smsConsent: true });
    await expect(
      decideBookingTextConsent(deps, { ...input, tenantId: OTHER_TENANT }),
    ).resolves.toEqual({ action: 'no_promise', reason: 'unverifiable' });
  });

  it.each(['customerRepo', 'consentEventRepo', 'dncRepo'] as const)(
    'a missing %s dependency withholds the promise instead of assuming consent',
    async (missing) => {
      const deps = await setup({ smsConsent: true });
      await expect(
        decideBookingTextConsent({ ...deps, [missing]: undefined }, input),
      ).resolves.toEqual({ action: 'no_promise', reason: 'unverifiable' });
    },
  );

  it.each(['customerRepo', 'consentEventRepo', 'dncRepo'] as const)(
    'a failing %s lookup never throws — the promise is withheld',
    async (failing) => {
      const deps = await setup({ smsConsent: true });
      const boom = vi.fn().mockRejectedValue(new Error('db down'));
      const broken = {
        ...deps,
        customerRepo: failing === 'customerRepo' ? { findById: boom } : deps.customerRepo,
        consentEventRepo: failing === 'consentEventRepo' ? { listByPhone: boom } : deps.consentEventRepo,
        dncRepo: failing === 'dncRepo' ? { isOnDnc: boom } : deps.dncRepo,
      };
      await expect(decideBookingTextConsent(broken, input)).resolves.toEqual({
        action: 'no_promise',
        reason: 'unverifiable',
      });
    },
  );
});
