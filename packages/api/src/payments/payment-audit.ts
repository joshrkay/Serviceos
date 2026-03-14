import { AuditRepository, AuditEvent, createAuditEvent } from '../audit/audit';

export type PaymentEventType = 'payment.recorded' | 'payment.completed' | 'payment.failed' | 'invoice.status_changed';

export async function logPaymentEvent(
  tenantId: string,
  invoiceId: string,
  paymentId: string,
  eventType: PaymentEventType,
  actorId: string,
  actorRole: string,
  auditRepo: AuditRepository,
  metadata?: Record<string, unknown>
): Promise<AuditEvent> {
  const event = createAuditEvent({
    tenantId,
    actorId,
    actorRole,
    eventType,
    entityType: 'invoice',
    entityId: invoiceId,
    correlationId: paymentId,
    metadata: { paymentId, ...metadata },
  });
  return auditRepo.create(event);
}

export async function getPaymentTimeline(
  tenantId: string,
  invoiceId: string,
  auditRepo: AuditRepository
): Promise<AuditEvent[]> {
  const events = await auditRepo.findByEntity(tenantId, 'invoice', invoiceId);
  return events.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}
