import { describe, expect, it } from 'vitest';
import { InMemoryDncRepository, normalizePhone } from '../../src/compliance/dnc';

describe('InMemoryDncRepository', () => {
  it('addToDnc marks a phone as on the list (suffix match tolerates country code)', async () => {
    const repo = new InMemoryDncRepository();
    await repo.addToDnc('tenant-1', normalizePhone('+15551234567'), 'inbound-stop');
    expect(await repo.isOnDnc('tenant-1', normalizePhone('555-123-4567'))).toBe(true);
  });

  it('removeFromDnc clears the suppression', async () => {
    const repo = new InMemoryDncRepository();
    await repo.addToDnc('tenant-1', normalizePhone('+15551234567'), 'inbound-stop');
    await repo.removeFromDnc('tenant-1', normalizePhone('+15551234567'));
    expect(await repo.isOnDnc('tenant-1', normalizePhone('5551234567'))).toBe(false);
  });

  it('addToDnc is idempotent', async () => {
    const repo = new InMemoryDncRepository();
    await repo.addToDnc('tenant-1', normalizePhone('+15551234567'), 'inbound-stop');
    await repo.addToDnc('tenant-1', normalizePhone('+15551234567'), 'inbound-stop');
    expect(await repo.isOnDnc('tenant-1', normalizePhone('+15551234567'))).toBe(true);
  });

  it('tenant isolation: tenant-2 cannot see tenant-1 suppressions', async () => {
    const repo = new InMemoryDncRepository();
    await repo.addToDnc('tenant-1', normalizePhone('+15551234567'), 'inbound-stop');
    expect(await repo.isOnDnc('tenant-2', normalizePhone('+15551234567'))).toBe(false);
  });
});
