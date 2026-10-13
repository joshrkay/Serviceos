/**
 * The send window must be open where the RECIPIENT is, not only where the
 * tenant is. Through the real gate + recipient-locale resolver: the window is
 * the intersection of the tenant's zone and every zone the recipient can be
 * placed in — the phone's NANP area-code state and each service-location
 * state (all zones of a multi-zone state). Requiring all of them can only
 * shrink the window.
 *
 * Instants are October 2026 (EDT = UTC-4, CDT = UTC-5, PDT = UTC-7, MST = UTC-7).
 */
import { describe, it, expect } from 'vitest';
import { GatedMessageDelivery, SmsDeferredError } from '../../src/notifications/gated-message-delivery';
import { InMemoryDeliveryProvider, type SmsMessage } from '../../src/notifications/delivery-provider';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemoryDncRepository } from '../../src/compliance/dnc';
import { InMemorySettingsRepository } from '../../src/settings/settings';
import { InMemoryLocationRepository } from '../../src/locations/location';
import { createRecipientLocaleResolver } from '../../src/notifications/recipient-locale';

const TENANT = '11111111-1111-1111-1111-111111111111';
const CUSTOMER = 'cust-1';
const CREATED = new Date('2026-01-01T00:00:00Z');

async function build(opts: { tenantZone: string; now: Date; locationState?: string }) {
  const settingsRepo = new InMemorySettingsRepository();
  await settingsRepo.create({
    id: 's-1',
    tenantId: TENANT,
    businessName: 'Acme',
    timezone: opts.tenantZone,
    estimatePrefix: 'EST',
    invoicePrefix: 'INV',
    nextEstimateNumber: 1,
    nextInvoiceNumber: 1,
    defaultPaymentTermDays: 14,
    createdAt: CREATED,
    updatedAt: CREATED,
  });
  const locationRepo = new InMemoryLocationRepository();
  if (opts.locationState) {
    await locationRepo.create({
      id: 'loc-1',
      tenantId: TENANT,
      customerId: CUSTOMER,
      street1: '1 Main St',
      city: 'Somewhere',
      state: opts.locationState,
      postalCode: '00000',
      country: 'US',
      isPrimary: true,
      addressType: 'service',
      isArchived: false,
      createdAt: CREATED,
      updatedAt: CREATED,
    });
  }
  const base = new InMemoryDeliveryProvider();
  const gate = new GatedMessageDelivery({
    base,
    dnc: new InMemoryDncRepository(),
    auditRepo: new InMemoryAuditRepository(),
    enforcement: 'block',
    quietHours: {
      resolveRecipientLocale: createRecipientLocaleResolver({ settingsRepo, locationRepo }),
      now: () => opts.now,
    },
    logger: { info: () => undefined },
  });
  return { gate, base };
}

function textTo(to: string): SmsMessage {
  return {
    to,
    body: 'Thanks for choosing Acme!',
    tenantId: TENANT,
    recipientClass: 'customer',
    consent: { smsConsent: true, customerId: CUSTOMER },
    quietHours: 'defer',
  };
}

describe('recipient-zone send window (tenant zone ∩ recipient zones)', () => {
  it('a Los Angeles tenant cannot text a Miami (305) number at 19:30 PT = 22:30 ET', async () => {
    const { gate, base } = await build({
      tenantZone: 'America/Los_Angeles',
      now: new Date('2026-10-13T02:30:00Z'),
    });

    const err = await gate.sendSms(textTo('+13055550100')).catch((e: unknown) => e);

    expect(base.sentSms).toHaveLength(0);
    expect(err).toBeInstanceOf(SmsDeferredError);
    // 08:00 PT (11:00 ET, 10:00 CT — Florida's panhandle is Central) is the
    // first instant every zone is open.
    expect((err as SmsDeferredError).nextAllowedAt.toISOString()).toBe('2026-10-13T15:00:00.000Z');
  });

  it('a New York tenant cannot text a Seattle (206) number at 08:00 ET = 05:00 PT', async () => {
    const { gate, base } = await build({
      tenantZone: 'America/New_York',
      now: new Date('2026-10-13T12:00:00Z'),
    });

    const err = await gate.sendSms(textTo('+12065550100')).catch((e: unknown) => e);

    expect(base.sentSms).toHaveLength(0);
    expect((err as SmsDeferredError).nextAllowedAt.toISOString()).toBe('2026-10-13T15:00:00.000Z');
  });

  it("a zone left at the pre-263 America/New_York default does not open a Phoenix customer's window at 05:00 MST", async () => {
    const { gate, base } = await build({
      tenantZone: 'America/New_York',
      now: new Date('2026-10-13T12:00:00Z'),
      locationState: 'AZ',
    });

    const err = await gate.sendSms(textTo('+16025550100')).catch((e: unknown) => e);

    expect(base.sentSms).toHaveLength(0);
    // 08:00 MST. Arizona also lists America/Denver (the Navajo Nation keeps DST).
    expect((err as SmsDeferredError).nextAllowedAt.toISOString()).toBe('2026-10-13T15:00:00.000Z');
  });

  it('still sends once every zone is open (a 206 number at 11:00 ET = 08:00 PT)', async () => {
    const { gate, base } = await build({
      tenantZone: 'America/New_York',
      now: new Date('2026-10-13T15:00:00Z'),
    });

    await gate.sendSms(textTo('+12065550100'));

    expect(base.sentSms).toHaveLength(1);
  });

  it("an area code never relaxes the close: a 212 number with no service address still closes at 20:00", async () => {
    const { gate, base } = await build({
      tenantZone: 'America/New_York',
      now: new Date('2026-10-14T00:30:00Z'), // 20:30 EDT
    });

    const err = await gate.sendSms(textTo('+12125550100')).catch((e: unknown) => e);

    expect(base.sentSms).toHaveLength(0);
    expect(err).toBeInstanceOf(SmsDeferredError);
  });
});

describe('free-text service-location states (M4)', () => {
  const EVENING = new Date('2026-10-14T00:30:00Z'); // 20:30 EDT

  it('a service address stored as "Florida" gets the Florida 20:00 close', async () => {
    const { gate, base } = await build({ tenantZone: 'America/New_York', now: EVENING, locationState: 'Florida' });

    const err = await gate.sendSms(textTo('+12125550100')).catch((e: unknown) => e);

    expect(base.sentSms).toHaveLength(0);
    expect(err).toBeInstanceOf(SmsDeferredError);
  });

  it('an unrecognisable state is treated as unknown (20:00 close), not as "not early-close"', async () => {
    const { gate, base } = await build({ tenantZone: 'America/New_York', now: EVENING, locationState: 'Narnia' });

    const err = await gate.sendSms(textTo('+12125550100')).catch((e: unknown) => e);

    expect(base.sentSms).toHaveLength(0);
    expect(err).toBeInstanceOf(SmsDeferredError);
  });

  it('a recognised non-early-close state ("new york") still gets the federal 21:00 close', async () => {
    const { gate, base } = await build({ tenantZone: 'America/New_York', now: EVENING, locationState: ' new york ' });

    await gate.sendSms(textTo('+12125550100'));

    expect(base.sentSms).toHaveLength(1);
  });
});
