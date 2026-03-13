import { v4 as uuidv4 } from 'uuid';

export interface AuditEvent {
  id: string;
  tenantId: string;
  actorId: string;
  actorRole: string;
  eventType: string;
  entityType: string;
  entityId: string;
  correlationId?: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
}

export interface AuditEventInput {
  tenantId: string;
  actorId: string;
  actorRole: string;
  eventType: string;
  entityType: string;
  entityId: string;
  correlationId?: string;
  metadata?: Record<string, unknown>;
}

export interface AuditRepository {
  create(event: AuditEvent): Promise<AuditEvent>;
  findByEntity(tenantId: string, entityType: string, entityId: string): Promise<AuditEvent[]>;
  findByCorrelation(tenantId: string, correlationId: string): Promise<AuditEvent[]>;
}

export function createAuditEvent(input: AuditEventInput): AuditEvent {
  if (!input.tenantId) throw new Error('tenantId is required for audit event');
  if (!input.actorId) throw new Error('actorId is required for audit event');
  if (!input.eventType) throw new Error('eventType is required for audit event');
  if (!input.entityType) throw new Error('entityType is required for audit event');
  if (!input.entityId) throw new Error('entityId is required for audit event');

  return {
    id: uuidv4(),
    tenantId: input.tenantId,
    actorId: input.actorId,
    actorRole: input.actorRole,
    eventType: input.eventType,
    entityType: input.entityType,
    entityId: input.entityId,
    correlationId: input.correlationId || uuidv4(),
    metadata: input.metadata || {},
    createdAt: new Date(),
  };
}

export class InMemoryAuditRepository implements AuditRepository {
  private events: AuditEvent[] = [];

  async create(event: AuditEvent): Promise<AuditEvent> {
    this.events.push({ ...event });
    return event;
  }

  async findByEntity(tenantId: string, entityType: string, entityId: string): Promise<AuditEvent[]> {
    return this.events.filter(
      (e) => e.tenantId === tenantId && e.entityType === entityType && e.entityId === entityId
    );
  }

  async findByCorrelation(tenantId: string, correlationId: string): Promise<AuditEvent[]> {
    return this.events.filter(
      (e) => e.tenantId === tenantId && e.correlationId === correlationId
    );
  }

  getAll(): AuditEvent[] {
    return [...this.events];
  }

  clear(): void {
    this.events = [];
  }
}
