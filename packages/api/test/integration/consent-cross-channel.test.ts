/**
 * WS12 / D-017 — one consent model, end to end against real Postgres.
 *
 * Pins the pieces a mocked-Pool unit test can't (per CLAUDE.md): the REAL
 * `consent_events` columns the voice gate's new in-transaction ledger query
 * reads, the REAL PgConsentEventRepository the SMS gate consults, the
 * `updateCustomer` manual-toggle ledger append, and the tightened
 * `updateDerivedConsentStatus` rollup (grants are a no-op).
 *
 * The headline behaviors:
 *   - an SMS STOP blocks the CALL even when consent_status still reads
 *     'granted' (cross-channel revocation via the ledger);
 *   - a portal/manual sms_consent opt-out suppresses SMS via the ledger even
 *     while the stored sms_consent flag is later flipped back on drifted data;
 *   - a recording objection does NOT suppress SMS (kind-scoping).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgDncRepository } from '../../src/compliance/dnc';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import {
  PgConsentEventRepository,
  updateDerivedConsentStatus,
} from '../../src/compliance/consent-events';
import { buildStopKeywordHandler } from '../../src/compliance/stop-reply';
import { checkOutboundConsent } from '../../src/voice/outbound-consent';
import { updateCustomer } from '../../src/customers/customer';
import {
  GatedMessageDelivery,
  SmsSuppressedError,
} from '../../src/notifications/gated-message-delivery';
import type {
  DeliveryResult,
  EmailMessage,
  MessageDeliveryProvider,
  SmsMessage,
} from '../../src/notifications/delivery-provider';
import type { Customer } from '../../src/customers/customer';

class RecordingBase implements MessageDeliveryProvider {
  readonly sent: SmsMessage[] = [];
  async sendSms(m: SmsMessage): Promise<DeliveryResult> {
    this.sent.push(m);
    return { providerMessageId: 'rec-sms', provider: 'recording', channel: 'sms' };
  }
  async sendEmail(_m: EmailMessage): Promise<DeliveryResult> {
    return { providerMessageId: 'rec-email', provider: 'recording', channel: 'email' };
  }
}

function makeCustomer(tenantId: string, phone: string): Customer {
  const now = new Date();
  return {
    id: randomUUID(),
    tenantId,
    firstName: 'Cross',
    lastName: 'Channel',
    displayName: 'Cross Channel',
    preferredChannel: 'sms',
    primaryPhone: phone,
    smsConsent: true,
    isArchived: false,
    createdBy: 'test',
    createdAt: now,
    updatedAt: now,
  };
}

const ACTOR = { actorId: 'voice-worker-1', actorRole: 'system' };

describe('Postgres integration — WS12 one consent model (cross-channel)', () => {
  let pool: Pool;
  let customerRepo: PgCustomerRepository;
  let dncRepo: PgDncRepository;
  let consentRepo: PgConsentEventRepository;
  let auditRepo: PgAuditRepository;
  let tenant: { tenantId: string; userId: string };

  beforeAll(async () => {
    pool = await getSharedTestDb();
    customerRepo = new PgCustomerRepository(pool);
    dncRepo = new PgDncRepository(pool);
    consentRepo = new PgConsentEventRepository(pool);
    auditRepo = new PgAuditRepository(pool);
    tenant = await createTestTenant(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  function smsGate(base: RecordingBase): GatedMessageDelivery {
    return new GatedMessageDelivery({
      base,
      dnc: dncRepo,
      auditRepo,
      enforcement: 'block',
      consentLedger: consentRepo,
    });
  }

  async function forceConsentStatus(customerId: string, status: string): Promise<void> {
    // Simulate rollup drift (or a pre-WS12 grant) directly — superuser
    // connection, tenant-scoped predicate.
    await pool.query(
      `UPDATE customers SET consent_status = $3 WHERE tenant_id = $1 AND id = $2`,
      [tenant.tenantId, customerId, status],
    );
  }

  it('an SMS STOP blocks the CALL even when consent_status still reads granted', async () => {
    const phone = '+15557650001';
    const cust = await customerRepo.create(makeCustomer(tenant.tenantId, phone));

    // STOP → DNC + ledger + rollup. Then force the rollup back to 'granted'
    // to prove the LEDGER (not the rollup) carries the cross-channel block.
    await buildStopKeywordHandler({ dncRepo, consentRepo, customerRepo, pool }).handle({
      tenantId: tenant.tenantId,
      fromE164: phone,
      body: 'STOP',
      messageSid: `SM-${randomUUID()}`,
    });
    await forceConsentStatus(cust.id, 'granted');
    // Clear the DNC row too — the ledger revocation alone must block.
    await dncRepo.removeFromDnc(tenant.tenantId, phone.replace(/\D/g, ''));

    const res = await checkOutboundConsent(
      { pool },
      { tenantId: tenant.tenantId, phoneE164: phone, ...ACTOR },
    );
    expect(res.allowed).toBe(false);
    expect(res.reason).toBe('consent_revoked');
  });

  it('a manual sms_consent opt-out (updateCustomer + ledger) suppresses SMS at the gate', async () => {
    const phone = '+15557650002';
    const cust = await customerRepo.create(makeCustomer(tenant.tenantId, phone));

    // Dashboard opt-out through the service seam — appends the ledger row.
    await updateCustomer(
      tenant.tenantId,
      cust.id,
      { smsConsent: false },
      customerRepo,
      'user-1',
      undefined,
      consentRepo,
    );
    const events = await consentRepo.listByPhone(tenant.tenantId, phone);
    expect(events[0]).toMatchObject({ kind: 'sms', state: 'revoked', source: 'manual' });

    // Even if a send site passes a stale smsConsent=true snapshot, the
    // standing ledger revocation suppresses the send.
    const base = new RecordingBase();
    await expect(
      smsGate(base).sendSms({
        to: phone,
        body: 'hi',
        tenantId: tenant.tenantId,
        recipientClass: 'customer',
        consent: { smsConsent: true, customerId: cust.id },
      }),
    ).rejects.toMatchObject({ reason: 'revoked' });
    expect(base.sent).toHaveLength(0);
  });

  it('a recording objection does NOT suppress SMS (kind-scoping)', async () => {
    const phone = '+15557650003';
    const cust = await customerRepo.create(makeCustomer(tenant.tenantId, phone));
    await consentRepo.append({
      tenantId: tenant.tenantId,
      customerId: cust.id,
      phone,
      kind: 'recording',
      state: 'revoked',
      source: 'voice',
      voiceSessionId: 'sess-1',
    });

    const base = new RecordingBase();
    await smsGate(base).sendSms({
      to: phone,
      body: 'your appointment is confirmed',
      tenantId: tenant.tenantId,
      recipientClass: 'customer',
      consent: { smsConsent: true, customerId: cust.id },
    });
    expect(base.sent).toHaveLength(1);
  });

  it('SMS re-opt-in (ledger grant) restores SMS but never grants the voice rollup', async () => {
    const phone = '+15557650004';
    const cust = await customerRepo.create(makeCustomer(tenant.tenantId, phone));

    // Revoke then re-grant on the ledger (manual portal toggle round-trip).
    for (const smsConsent of [false, true]) {
      await updateCustomer(
        tenant.tenantId,
        cust.id,
        { smsConsent },
        customerRepo,
        'user-1',
        undefined,
        consentRepo,
      );
    }

    // SMS flows again…
    const base = new RecordingBase();
    await smsGate(base).sendSms({
      to: phone,
      body: 'hi again',
      tenantId: tenant.tenantId,
      recipientClass: 'customer',
      consent: { smsConsent: true, customerId: cust.id },
    });
    expect(base.sent).toHaveLength(1);

    // …but the voice rollup was never granted, and the tightened
    // updateDerivedConsentStatus is a no-op for grants (returns false).
    const rolled = await updateDerivedConsentStatus(pool, {
      tenantId: tenant.tenantId,
      customerId: cust.id,
      phone,
      kind: 'sms',
      state: 'granted',
      source: 'manual',
    });
    expect(rolled).toBe(false);
    const after = await customerRepo.findById(tenant.tenantId, cust.id);
    expect(after!.consentStatus).not.toBe('granted');

    const voiceRes = await checkOutboundConsent(
      { pool },
      { tenantId: tenant.tenantId, phoneE164: phone, ...ACTOR },
    );
    expect(voiceRes.allowed).toBe(false); // not_requested — fail closed
  });

  it('a granted voice customer with a clean ledger can still be texted AND called', async () => {
    const phone = '+15557650005';
    const cust = await customerRepo.create(makeCustomer(tenant.tenantId, phone));
    await forceConsentStatus(cust.id, 'granted');

    const voiceRes = await checkOutboundConsent(
      { pool },
      { tenantId: tenant.tenantId, phoneE164: phone, ...ACTOR },
    );
    expect(voiceRes).toEqual({ allowed: true });

    const base = new RecordingBase();
    await smsGate(base).sendSms({
      to: phone,
      body: 'hi',
      tenantId: tenant.tenantId,
      recipientClass: 'customer',
      consent: { smsConsent: true, customerId: cust.id },
    });
    expect(base.sent).toHaveLength(1);
  });

  it('suppression still surfaces as SmsSuppressedError (caller contract intact)', async () => {
    const phone = '+15557650006';
    const cust = await customerRepo.create(makeCustomer(tenant.tenantId, phone));
    await consentRepo.append({
      tenantId: tenant.tenantId,
      customerId: cust.id,
      phone,
      kind: 'marketing',
      state: 'revoked',
      source: 'portal',
    });

    await expect(
      smsGate(new RecordingBase()).sendSms({
        to: phone,
        body: 'promo',
        tenantId: tenant.tenantId,
        recipientClass: 'customer',
        consent: { smsConsent: true, customerId: cust.id },
      }),
    ).rejects.toBeInstanceOf(SmsSuppressedError);
  });
});
