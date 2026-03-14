import { faker } from '@faker-js/faker';
import { AuditEvent } from '../../src/audit/audit';

export function buildAuditEvent(overrides?: Partial<AuditEvent>): AuditEvent {
  return {
    id: faker.string.uuid(),
    tenantId: faker.string.uuid(),
    actorId: faker.string.uuid(),
    actorRole: faker.helpers.arrayElement(['owner', 'dispatcher', 'technician']),
    eventType: faker.helpers.arrayElement([
      'customer.created', 'customer.updated', 'job.created', 'estimate.created', 'invoice.created',
    ]),
    entityType: faker.helpers.arrayElement(['customer', 'job', 'estimate', 'invoice']),
    entityId: faker.string.uuid(),
    correlationId: faker.string.uuid(),
    metadata: {},
    createdAt: faker.date.recent(),
    ...overrides,
  };
}
