/**
 * Postgres integration — Story 10.6 opt-out unification. A STOP reply must
 * update all three stores at once: tenant_dnc_list, the consent_events ledger,
 * and the customers.consent_status rollup. Also proves cross-tenant isolation
 * (a STOP for tenant A never touches tenant B's same-numbered customer).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgDncRepository, normalizePhone } from '../../src/compliance/dnc';
import { PgConsentEventRepository } from '../../src/compliance/consent-events';
import { buildStopKeywordHandler, buildStartKeywordHandler } from '../../src/compliance/stop-reply';
import type { Customer } from '../../src/customers/customer';

const PHONE = '+15551239876';

function customer(tenantId: string): Customer {
  const now = new Date();
  return {
    id: randomUUID(),
    tenantId,
    firstName: 'Opt',
    lastName: 'Out',
    displayName: 'Opt Out',
    preferredChannel: 'sms',
    primaryPhone: PHONE,
    smsConsent: true,
    isArchived: false,
    createdBy: 'test',
    createdAt: now,
    updatedAt: now,
  };
}

function ctx(tenantId: string) {
  return { tenantId, fromE164: PHONE, body: 'STOP', messageSid: `SM-${randomUUID()}` };
}

describe('Postgres integration — STOP/START opt-out unification', () => {
  let pool: Pool;
  let customerRepo: PgCustomerRepository;
  let dncRepo: PgDncRepository;
  let consentRepo: PgConsentEventRepository;
  let tenant: { tenantId: string; userId: string };

  beforeAll(async () => {
    pool = await getSharedTestDb();
    customerRepo = new PgCustomerRepository(pool);
    dncRepo = new PgDncRepository(pool);
    consentRepo = new PgConsentEventRepository(pool);
    tenant = await createTestTenant(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('STOP updates DNC, the consent ledger, and the customer rollup together', async () => {
    const cust = await customerRepo.create(customer(tenant.tenantId));
    const handler = buildStopKeywordHandler({ dncRepo, consentRepo, customerRepo, pool });

    const result = await handler.handle(ctx(tenant.tenantId));
    expect(result.handled).toBe(true);

    expect(await dncRepo.isOnDnc(tenant.tenantId, normalizePhone(PHONE))).toBe(true);

    const events = await consentRepo.listByPhone(tenant.tenantId, PHONE);
    expect(events[0].kind).toBe('sms');
    expect(events[0].state).toBe('revoked');
    expect(events[0].customerId).toBe(cust.id);

    const after = await customerRepo.findById(tenant.tenantId, cust.id);
    expect(after!.consentStatus).toBe('revoked');
  });

  it('START clears DNC + ledgers the re-grant, but never re-grants the voice rollup (WS12/D-017)', async () => {
    const cust = await customerRepo.create(customer(tenant.tenantId));
    await buildStopKeywordHandler({ dncRepo, consentRepo, customerRepo, pool }).handle(
      ctx(tenant.tenantId),
    );

    await buildStartKeywordHandler({ dncRepo, consentRepo, customerRepo, pool }).handle({
      ...ctx(tenant.tenantId),
      body: 'START',
    });

    expect(await dncRepo.isOnDnc(tenant.tenantId, normalizePhone(PHONE))).toBe(false);
    // The ledger records the re-grant (newest first) — this is what clears
    // the sms-kind revocation at both outbound gates.
    const events = await consentRepo.listByPhone(tenant.tenantId, PHONE);
    expect(events[0].kind).toBe('sms');
    expect(events[0].state).toBe('granted');
    // Deliberate WS12 reversal of the original Story 10.6 assertion: an SMS
    // re-opt-in must NOT manufacture voice-call consent, so consent_status
    // stays 'revoked' (only the voice capture seam can grant it).
    const after = await customerRepo.findById(tenant.tenantId, cust.id);
    expect(after!.consentStatus).toBe('revoked');
  });

  it('does not roll up consent onto another tenant sharing the number', async () => {
    const other = await createTestTenant(pool);
    const otherCust = await customerRepo.create(customer(other.tenantId));

    await buildStopKeywordHandler({ dncRepo, consentRepo, customerRepo, pool }).handle(
      ctx(tenant.tenantId),
    );

    const otherAfter = await customerRepo.findById(other.tenantId, otherCust.id);
    expect(otherAfter!.consentStatus).not.toBe('revoked');
  });
});
