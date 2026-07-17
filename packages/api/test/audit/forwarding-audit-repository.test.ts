import { describe, it, expect, vi } from 'vitest';
import { ForwardingAuditRepository } from '../../src/audit/forwarding-audit-repository';
import {
  createAuditEvent,
  InMemoryAuditRepository,
  type AuditEvent,
  type AuditRepository,
} from '../../src/audit/audit';

function auditEvent(over: Partial<AuditEvent> = {}): AuditEvent {
  return createAuditEvent({
    tenantId: over.tenantId ?? 't_1',
    actorId: over.actorId ?? 'clerk_owner',
    actorRole: over.actorRole ?? 'owner',
    eventType: over.eventType ?? 'proposal.approved',
    entityType: over.entityType ?? 'proposal',
    entityId: over.entityId ?? 'p_1',
    metadata: over.metadata ?? { proposalType: 'issue_invoice', status: 'approved' },
  });
}

describe('ForwardingAuditRepository', () => {
  it('awaits the inner write, then forwards a mapped event once with $insert_id = saved.id', async () => {
    const inner = new InMemoryAuditRepository();
    const record = vi.fn();
    const repo = new ForwardingAuditRepository(inner, { isEnabled: () => true, record });

    const saved = await repo.create(auditEvent());

    // Inner persisted it.
    expect(inner.getAll()).toHaveLength(1);
    expect(record).toHaveBeenCalledTimes(1);
    const [name, payload] = record.mock.calls[0];
    expect(name).toBe('proposal_approved');
    expect(payload.tenantId).toBe('t_1');
    expect(payload.distinctId).toBe('clerk_owner');
    expect(payload.insertId).toBe(saved.id);
    expect(payload.properties).toMatchObject({
      feature_domain: 'proposal',
      audit_event_type: 'proposal.approved',
      proposal_type: 'issue_invoice',
    });
  });

  it('does not forward an un-allowlisted event', async () => {
    const inner = new InMemoryAuditRepository();
    const record = vi.fn();
    const repo = new ForwardingAuditRepository(inner, { isEnabled: () => true, record });

    await repo.create(auditEvent({ eventType: 'customer.updated', entityType: 'customer' }));

    expect(inner.getAll()).toHaveLength(1);
    expect(record).not.toHaveBeenCalled();
  });

  it('skips mapping + forwarding entirely when analytics is disabled', async () => {
    const inner = new InMemoryAuditRepository();
    const record = vi.fn();
    const map = vi.fn();
    const repo = new ForwardingAuditRepository(inner, { isEnabled: () => false, record, map });

    await repo.create(auditEvent());

    expect(inner.getAll()).toHaveLength(1);
    expect(map).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it('still resolves to the saved event when recordProductEvent throws', async () => {
    const inner = new InMemoryAuditRepository();
    const record = vi.fn(() => {
      throw new Error('posthog boom');
    });
    const repo = new ForwardingAuditRepository(inner, { isEnabled: () => true, record });

    const saved = await repo.create(auditEvent());

    expect(saved.eventType).toBe('proposal.approved');
    expect(inner.getAll()).toHaveLength(1);
  });

  it('forwards nothing and propagates the error when the inner write rejects', async () => {
    const boom = new Error('db down');
    const inner: AuditRepository = {
      create: vi.fn().mockRejectedValue(boom),
      findByEntity: vi.fn(),
      findByCorrelation: vi.fn(),
    };
    const record = vi.fn();
    const repo = new ForwardingAuditRepository(inner, { isEnabled: () => true, record });

    await expect(repo.create(auditEvent())).rejects.toThrow('db down');
    expect(record).not.toHaveBeenCalled();
  });

  it('delegates read methods verbatim', async () => {
    const inner: AuditRepository = {
      create: vi.fn(),
      findByEntity: vi.fn().mockResolvedValue(['by-entity']),
      findByCorrelation: vi.fn().mockResolvedValue(['by-correlation']),
      findRecentByTenant: vi.fn().mockResolvedValue(['recent']),
    };
    const repo = new ForwardingAuditRepository(inner);

    await expect(repo.findByEntity('t', 'proposal', 'p_1')).resolves.toEqual(['by-entity']);
    expect(inner.findByEntity).toHaveBeenCalledWith('t', 'proposal', 'p_1');

    await expect(repo.findByCorrelation('t', 'c_1')).resolves.toEqual(['by-correlation']);
    expect(inner.findByCorrelation).toHaveBeenCalledWith('t', 'c_1');

    // findRecentByTenant is exposed because the inner repo supports it.
    expect(repo.findRecentByTenant).toBeDefined();
    await expect(repo.findRecentByTenant!('t', { limit: 5 })).resolves.toEqual(['recent']);
    expect(inner.findRecentByTenant).toHaveBeenCalledWith('t', { limit: 5 });
  });

  it('does not advertise findRecentByTenant when the inner repo lacks it', () => {
    const inner: AuditRepository = {
      create: vi.fn(),
      findByEntity: vi.fn(),
      findByCorrelation: vi.fn(),
    };
    const repo = new ForwardingAuditRepository(inner);
    expect(repo.findRecentByTenant).toBeUndefined();
  });
});
