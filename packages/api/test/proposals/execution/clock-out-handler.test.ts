import { describe, it, expect } from 'vitest';
import { ClockOutExecutionHandler } from '../../../src/proposals/execution/full-app-voice-handlers';
import { InMemoryTimeEntryRepository } from '../../../src/time-tracking/time-entry';
import { TimeEntryService } from '../../../src/time-tracking/time-entry-service';
import { InMemoryAuditRepository } from '../../../src/audit/audit';
import { Proposal } from '../../../src/proposals/proposal';

const TENANT = 'tenant-1';
const TECH = 'tech-1';

function proposal(payload: Record<string, unknown> = {}): Proposal {
  return {
    id: 'p-1',
    tenantId: TENANT,
    proposalType: 'clock_out',
    status: 'approved',
    payload,
    summary: 'clock out',
    createdBy: 'system',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('ClockOutExecutionHandler', () => {
  it('closes the tech\'s active time entry and returns its id', async () => {
    const repo = new InMemoryTimeEntryRepository();
    const service = new TimeEntryService(repo, new InMemoryAuditRepository());
    const entry = await service.clockIn(TENANT, TECH, { entryType: 'job' });
    const handler = new ClockOutExecutionHandler(service);

    const result = await handler.execute(proposal(), { tenantId: TENANT, executedBy: TECH });

    expect(result.success).toBe(true);
    expect(result.resultEntityId).toBe(entry.id);
    expect(await service.findActiveEntry(TENANT, TECH)).toBeNull();
  });

  it('is a no-op success when the tech has no open entry', async () => {
    const repo = new InMemoryTimeEntryRepository();
    const service = new TimeEntryService(repo, new InMemoryAuditRepository());
    const handler = new ClockOutExecutionHandler(service);

    const result = await handler.execute(proposal(), { tenantId: TENANT, executedBy: TECH });

    expect(result).toEqual({ success: true });
  });

  it('passes the optional note through to the closed entry', async () => {
    const repo = new InMemoryTimeEntryRepository();
    const service = new TimeEntryService(repo, new InMemoryAuditRepository());
    const open = await service.clockIn(TENANT, TECH, { entryType: 'job' });
    const handler = new ClockOutExecutionHandler(service);

    await handler.execute(proposal({ notes: 'finished early' }), {
      tenantId: TENANT,
      executedBy: TECH,
    });

    const closed = await repo.findById(TENANT, open.id);
    expect(closed?.clockedOutAt).toBeInstanceOf(Date);
    expect(closed?.notes).toBe('finished early');
  });

  it('passthrough success when no time-entry service is wired', async () => {
    const handler = new ClockOutExecutionHandler();
    const result = await handler.execute(proposal(), { tenantId: TENANT, executedBy: TECH });
    expect(result).toEqual({ success: true });
  });
});
