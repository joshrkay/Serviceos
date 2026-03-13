import {
  createAuditEvent,
  InMemoryAuditRepository,
} from '../../src/audit/audit';

describe('P0-007 — Audit logging foundation', () => {
  let repo: InMemoryAuditRepository;

  beforeEach(() => {
    repo = new InMemoryAuditRepository();
  });

  it('happy path — creates audit event with all fields', () => {
    const event = createAuditEvent({
      tenantId: 'tenant-1',
      actorId: 'user-1',
      actorRole: 'owner',
      eventType: 'user.created',
      entityType: 'user',
      entityId: 'user-2',
      metadata: { email: 'test@example.com' },
    });

    expect(event.id).toBeTruthy();
    expect(event.tenantId).toBe('tenant-1');
    expect(event.actorId).toBe('user-1');
    expect(event.eventType).toBe('user.created');
    expect(event.correlationId).toBeTruthy();
    expect(event.createdAt).toBeInstanceOf(Date);
  });

  it('happy path — stores and retrieves by entity', async () => {
    const event = createAuditEvent({
      tenantId: 'tenant-1',
      actorId: 'user-1',
      actorRole: 'owner',
      eventType: 'job.created',
      entityType: 'job',
      entityId: 'job-1',
    });
    await repo.create(event);

    const results = await repo.findByEntity('tenant-1', 'job', 'job-1');
    expect(results).toHaveLength(1);
    expect(results[0].eventType).toBe('job.created');
  });

  it('happy path — retrieves by correlation ID', async () => {
    const event = createAuditEvent({
      tenantId: 'tenant-1',
      actorId: 'user-1',
      actorRole: 'owner',
      eventType: 'job.updated',
      entityType: 'job',
      entityId: 'job-1',
      correlationId: 'corr-123',
    });
    await repo.create(event);

    const results = await repo.findByCorrelation('tenant-1', 'corr-123');
    expect(results).toHaveLength(1);
  });

  it('validation — requires tenantId', () => {
    expect(() =>
      createAuditEvent({
        tenantId: '',
        actorId: 'user-1',
        actorRole: 'owner',
        eventType: 'test',
        entityType: 'test',
        entityId: 'test-1',
      })
    ).toThrow('tenantId is required');
  });

  it('validation — requires actorId', () => {
    expect(() =>
      createAuditEvent({
        tenantId: 'tenant-1',
        actorId: '',
        actorRole: 'owner',
        eventType: 'test',
        entityType: 'test',
        entityId: 'test-1',
      })
    ).toThrow('actorId is required');
  });

  it('validation — requires eventType', () => {
    expect(() =>
      createAuditEvent({
        tenantId: 'tenant-1',
        actorId: 'user-1',
        actorRole: 'owner',
        eventType: '',
        entityType: 'test',
        entityId: 'test-1',
      })
    ).toThrow('eventType is required');
  });
});
