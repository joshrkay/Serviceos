import { logPaymentEvent, getPaymentTimeline, PaymentEventType } from '../../src/payments/payment-audit';
import { InMemoryAuditRepository } from '../../src/audit/audit';

describe('P5-011C — Payment audit trail', () => {
  let auditRepo: InMemoryAuditRepository;

  const tenantId = 't1';
  const invoiceId = 'inv-1';
  const paymentId = 'pay-1';
  const actorId = 'user-1';
  const actorRole = 'system';

  beforeEach(() => {
    auditRepo = new InMemoryAuditRepository();
  });

  it('logPaymentEvent creates audit event with correct fields', async () => {
    const event = await logPaymentEvent(
      tenantId, invoiceId, paymentId, 'payment.recorded', actorId, actorRole, auditRepo
    );
    expect(event.tenantId).toBe(tenantId);
    expect(event.entityType).toBe('invoice');
    expect(event.entityId).toBe(invoiceId);
    expect(event.eventType).toBe('payment.recorded');
    expect(event.actorId).toBe(actorId);
    expect(event.actorRole).toBe(actorRole);
    expect(event.correlationId).toBe(paymentId);
  });

  it('event includes paymentId in metadata', async () => {
    const event = await logPaymentEvent(
      tenantId, invoiceId, paymentId, 'payment.completed', actorId, actorRole, auditRepo,
      { amountCents: 5000 }
    );
    expect(event.metadata).toMatchObject({ paymentId, amountCents: 5000 });
  });

  it('getPaymentTimeline returns sorted events', async () => {
    // Create events with different timestamps
    const base = new Date('2025-01-01T00:00:00Z');

    await logPaymentEvent(tenantId, invoiceId, paymentId, 'payment.recorded', actorId, actorRole, auditRepo);
    // Introduce slight delay via metadata to differentiate
    await logPaymentEvent(tenantId, invoiceId, paymentId, 'payment.completed', actorId, actorRole, auditRepo);
    await logPaymentEvent(tenantId, invoiceId, paymentId, 'invoice.status_changed', actorId, actorRole, auditRepo);

    const timeline = await getPaymentTimeline(tenantId, invoiceId, auditRepo);
    expect(timeline.length).toBe(3);
    // Verify sorted by createdAt ascending
    for (let i = 1; i < timeline.length; i++) {
      expect(timeline[i].createdAt.getTime()).toBeGreaterThanOrEqual(timeline[i - 1].createdAt.getTime());
    }
  });

  it('enforces tenant isolation', async () => {
    await logPaymentEvent(tenantId, invoiceId, paymentId, 'payment.recorded', actorId, actorRole, auditRepo);
    await logPaymentEvent('other-tenant', invoiceId, 'pay-2', 'payment.recorded', actorId, actorRole, auditRepo);

    const timeline = await getPaymentTimeline(tenantId, invoiceId, auditRepo);
    expect(timeline.length).toBe(1);
    expect(timeline[0].tenantId).toBe(tenantId);
  });

  it('multiple event types work', async () => {
    const types: PaymentEventType[] = ['payment.recorded', 'payment.completed', 'payment.failed', 'invoice.status_changed'];
    for (const eventType of types) {
      const event = await logPaymentEvent(tenantId, invoiceId, paymentId, eventType, actorId, actorRole, auditRepo);
      expect(event.eventType).toBe(eventType);
    }
    const all = auditRepo.getAll();
    expect(all.length).toBe(4);
  });
});
