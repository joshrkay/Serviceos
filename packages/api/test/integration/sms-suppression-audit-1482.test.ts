/**
 * #1482 — a blocked send must leave its audit row, even though the request
 * that tried to send answers >= 400.
 *
 * QA found zero `sms.suppressed` rows on dev after cap refusals and a DNC
 * refusal, while the cap itself enforced correctly. The request-transaction
 * middleware (middleware/tenant-context.ts) rolls back every write of a
 * request that answers >= 400, and the gate's audit write rode that same
 * transaction — so the refusal's audit was discarded together with the
 * refusal response.
 *
 * Seam: POST /api/conversations/:id/reply through the production
 * withTenantTransaction middleware, the production GatedMessageDelivery and
 * PgAuditRepository, read back through the audit repository.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import type { Pool } from 'pg';
import request from 'supertest';
import express, { Response, NextFunction } from 'express';
import { getSharedTestDb, createTestTenant, TestTenant } from './shared';
import { withTenantTransaction } from '../../src/middleware/tenant-context';
import { createConversationRouter } from '../../src/routes/conversations';
import { PgConversationRepository } from '../../src/conversations/pg-conversation';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgDispatchRepository } from '../../src/notifications/dispatch-repository';
import { PgDncRepository, normalizePhone } from '../../src/compliance/dnc';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { InMemoryDeliveryProvider } from '../../src/notifications/delivery-provider';
import { GatedMessageDelivery } from '../../src/notifications/gated-message-delivery';
import { InMemoryRecipientSmsVolumeLedger } from '../../src/notifications/recipient-sms-volume';
import type { AuthenticatedRequest } from '../../src/auth/clerk';
import type { Customer } from '../../src/customers/customer';

describe('Postgres integration — blocked sends are audited (#1482)', () => {
  let pool: Pool;
  let tenant: TestTenant;
  let app: express.Express;
  let conversationRepo: PgConversationRepository;
  let customerRepo: PgCustomerRepository;
  let dncRepo: PgDncRepository;
  let auditRepo: PgAuditRepository;

  async function customerThread(phone: string): Promise<{ conversationId: string; customerId: string }> {
    const now = new Date();
    const customer = await customerRepo.create({
      id: crypto.randomUUID(),
      tenantId: tenant.tenantId,
      firstName: 'Sam',
      lastName: 'Smith',
      displayName: 'Sam Smith',
      preferredChannel: 'sms',
      smsConsent: true,
      isArchived: false,
      primaryPhone: phone,
      createdBy: tenant.userId,
      createdAt: now,
      updatedAt: now,
    } as Customer);
    const conv = await conversationRepo.createConversation({
      tenantId: tenant.tenantId,
      title: 'Sam Smith',
      entityType: 'customer',
      entityId: customer.id,
      createdBy: tenant.userId,
    });
    return { conversationId: conv.id, customerId: customer.id };
  }

  beforeAll(async () => {
    pool = await getSharedTestDb();
    tenant = await createTestTenant(pool);
    conversationRepo = new PgConversationRepository(pool);
    customerRepo = new PgCustomerRepository(pool);
    dncRepo = new PgDncRepository(pool);
    auditRepo = new PgAuditRepository(pool);

    const delivery = new GatedMessageDelivery({
      base: new InMemoryDeliveryProvider(),
      dnc: dncRepo,
      auditRepo,
      enforcement: 'block',
      recipientVolumeCap: {
        ledger: new InMemoryRecipientSmsVolumeLedger(),
        maxPerWindow: 1,
        windowHours: 24,
      },
    });

    app = express();
    app.use(express.json());
    app.use((req, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = {
        userId: tenant.userId,
        canonicalUserId: tenant.userId,
        sessionId: 'sess-1482',
        tenantId: tenant.tenantId,
        role: 'owner',
      };
      next();
    });
    app.use('/api', withTenantTransaction(pool));
    app.use(
      '/api/conversations',
      createConversationRouter(conversationRepo, auditRepo, undefined, {
        customerRepo,
        dncRepo,
        dispatchRepo: new PgDispatchRepository(pool),
        delivery,
      }),
    );
  });

  it('a reply refused by the per-recipient cap leaves one sms.suppressed row with the reason', async () => {
    const { conversationId } = await customerThread('+15555551482');

    const first = await request(app)
      .post(`/api/conversations/${conversationId}/reply`)
      .send({ body: 'First text', channel: 'sms' });
    expect(first.status).toBe(201);

    const capped = await request(app)
      .post(`/api/conversations/${conversationId}/reply`)
      .send({ body: 'Second text', channel: 'sms' });
    expect(capped.status).toBe(429);

    // The gate keys the row on the phone's last 4 when the send carries no
    // customer id (a conversation reply does not) — PII-minimizing.
    const rows = (await auditRepo.findByEntity(tenant.tenantId, 'sms_message', 'sms-1482')).filter(
      (e) => e.eventType === 'sms.suppressed',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata).toMatchObject({ reason: 'recipient_volume_cap', phoneLast4: '1482' });
  });

  it('a reply refused for DNC leaves its suppression audit row with the reason', async () => {
    const phone = '+15555552482';
    const { conversationId } = await customerThread(phone);
    await dncRepo.addToDnc(tenant.tenantId, normalizePhone(phone), 'sms_stop');

    const res = await request(app)
      .post(`/api/conversations/${conversationId}/reply`)
      .send({ body: 'Hello', channel: 'sms' });
    expect(res.status).toBe(403);

    const rows = (
      await auditRepo.findByEntity(tenant.tenantId, 'conversation', conversationId)
    ).filter((e) => e.eventType === 'conversation.reply.suppressed');
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata).toMatchObject({ reason: 'dnc_blocked' });
  });
});
