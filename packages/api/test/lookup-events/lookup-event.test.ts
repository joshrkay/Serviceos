import { describe, it, expect, beforeEach } from 'vitest';
import {
  buildLookupEvent,
  InMemoryLookupEventRepository,
} from '../../src/lookup-events/lookup-event';
import { LookupEventService } from '../../src/lookup-events/lookup-event-service';

describe('P11-001 — LookupEvent repo + service', () => {
  let repo: InMemoryLookupEventRepository;
  let service: LookupEventService;

  beforeEach(() => {
    repo = new InMemoryLookupEventRepository();
    service = new LookupEventService(repo);
  });

  it('happy path — record() persists a new row with synthesized id + createdAt', async () => {
    const ev = await service.record({
      tenantId: 'tenant-1',
      sessionId: 'sess-1',
      customerId: 'cust-1',
      intent: 'lookup_appointments',
      resultStatus: 'found',
      resultCount: 2,
      summary: 'Your next appointment is Tuesday at 1 PM.',
      latencyMs: 42,
    });

    expect(ev.id).toMatch(/[a-f0-9-]{36}/);
    expect(ev.createdAt).toBeInstanceOf(Date);
    expect(ev.intent).toBe('lookup_appointments');

    const list = await service.list('tenant-1');
    expect(list).toHaveLength(1);
    expect(list[0].summary).toContain('Tuesday at 1 PM');
  });

  it('tenant isolation — list() never returns other tenants rows', async () => {
    await service.record({
      tenantId: 'tenant-1',
      sessionId: 'sess-1',
      intent: 'lookup_balance',
      resultStatus: 'found',
      resultCount: 1,
      summary: 'mine',
      latencyMs: 1,
    });
    await service.record({
      tenantId: 'tenant-2',
      sessionId: 'sess-2',
      intent: 'lookup_balance',
      resultStatus: 'found',
      resultCount: 1,
      summary: 'theirs',
      latencyMs: 1,
    });

    const list = await service.list('tenant-1');
    expect(list.map((r) => r.summary)).toEqual(['mine']);
  });

  it('list() filters by sessionId / customerId', async () => {
    await service.record({
      tenantId: 'tenant-1',
      sessionId: 'sess-A',
      customerId: 'cust-1',
      intent: 'lookup_jobs',
      resultStatus: 'found',
      resultCount: 1,
      summary: 'a',
      latencyMs: 1,
    });
    await service.record({
      tenantId: 'tenant-1',
      sessionId: 'sess-B',
      customerId: 'cust-2',
      intent: 'lookup_jobs',
      resultStatus: 'found',
      resultCount: 1,
      summary: 'b',
      latencyMs: 1,
    });

    expect((await service.list('tenant-1', { sessionId: 'sess-A' })).map((r) => r.summary)).toEqual(['a']);
    expect((await service.list('tenant-1', { customerId: 'cust-2' })).map((r) => r.summary)).toEqual(['b']);
  });

  it('validation — throws on missing tenantId / intent', () => {
    expect(() =>
      buildLookupEvent({
        tenantId: '',
        intent: 'lookup_jobs',
        resultStatus: 'none',
        resultCount: 0,
        summary: '',
        latencyMs: 0,
      }),
    ).toThrow();
    expect(() =>
      buildLookupEvent({
        tenantId: 'tenant-1',
        intent: '',
        resultStatus: 'none',
        resultCount: 0,
        summary: '',
        latencyMs: 0,
      }),
    ).toThrow();
  });
});
