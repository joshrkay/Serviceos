import { describe, it, expect } from 'vitest';
import { InMemoryMaterialItemRepository } from '../../src/materials/material-item';
import { ValidationError } from '../../src/shared/errors';

describe('MaterialItemRepository', () => {
  it('creates and lists pending items by tenant, optional job filter', async () => {
    const repo = new InMemoryMaterialItemRepository();
    await repo.create({
      tenantId: 't1', description: '3 boxes 1/2" PEX', quantity: 3,
      jobId: 'job-1', createdBy: 'u1',
    });
    await repo.create({ tenantId: 't1', description: 'Flue liner kit', quantity: 1, createdBy: 'u1' });
    await repo.create({ tenantId: 't2', description: 'other tenant', quantity: 1, createdBy: 'u2' });

    const all = await repo.listPending('t1');
    expect(all).toHaveLength(2);
    const forJob = await repo.listPending('t1', { jobId: 'job-1' });
    expect(forJob).toHaveLength(1);
    expect(forJob[0].description).toBe('3 boxes 1/2" PEX');

    await repo.markPurchased('t1', all[0].id, 'u1');
    expect(await repo.listPending('t1')).toHaveLength(1);
  });

  it('never leaks another tenant into listPending, even with a matching jobId filter', async () => {
    const repo = new InMemoryMaterialItemRepository();
    await repo.create({ tenantId: 't1', description: 'a', jobId: 'job-1', createdBy: 'u1' });
    await repo.create({ tenantId: 't2', description: 'b', jobId: 'job-1', createdBy: 'u2' });

    expect(await repo.listPending('t2')).toHaveLength(1);
    expect((await repo.listPending('t2'))[0].description).toBe('b');
    expect(await repo.listPending('t2', { jobId: 'job-1' })).toHaveLength(1);
    expect(await repo.listPending('nonexistent-tenant')).toHaveLength(0);
  });

  it('returns pending items oldest-created first', async () => {
    const repo = new InMemoryMaterialItemRepository();
    const first = await repo.create({ tenantId: 't1', description: 'first', createdBy: 'u1' });
    const second = await repo.create({ tenantId: 't1', description: 'second', createdBy: 'u1' });
    const third = await repo.create({ tenantId: 't1', description: 'third', createdBy: 'u1' });

    const pending = await repo.listPending('t1');
    expect(pending.map((i) => i.id)).toEqual([first.id, second.id, third.id]);
  });

  it('defaults quantity to 1 when omitted, matching the DB column default', async () => {
    const repo = new InMemoryMaterialItemRepository();
    const created = await repo.create({ tenantId: 't1', description: 'flux paste', createdBy: 'u1' });
    expect(created.quantity).toBe(1);
    const [found] = await repo.listPending('t1');
    expect(found.quantity).toBe(1);
  });

  it('defaults status to pending and leaves purchasedBy/purchasedAt unset on create', async () => {
    const repo = new InMemoryMaterialItemRepository();
    const created = await repo.create({ tenantId: 't1', description: 'copper fittings', createdBy: 'u1' });
    expect(created.status).toBe('pending');
    expect(created.purchasedBy).toBeUndefined();
    expect(created.purchasedAt).toBeUndefined();
    expect(created.createdAt).toBeInstanceOf(Date);
    expect(created.updatedAt).toBeInstanceOf(Date);
  });

  it('leaves optional fields (jobId, vendor, neededBy) undefined when not provided', async () => {
    const repo = new InMemoryMaterialItemRepository();
    const created = await repo.create({ tenantId: 't1', description: 'no extras', createdBy: 'u1' });
    expect(created.jobId).toBeUndefined();
    expect(created.vendor).toBeUndefined();
    expect(created.neededBy).toBeUndefined();
  });

  it('round-trips optional fields when provided', async () => {
    const repo = new InMemoryMaterialItemRepository();
    const neededBy = new Date('2026-09-01T00:00:00Z');
    const created = await repo.create({
      tenantId: 't1',
      description: 'flue liner kit',
      quantity: 2,
      jobId: 'job-9',
      vendor: 'Acme Supply',
      neededBy,
      createdBy: 'u1',
    });
    expect(created.jobId).toBe('job-9');
    expect(created.vendor).toBe('Acme Supply');
    expect(created.neededBy).toEqual(neededBy);
  });

  it('rejects a non-positive quantity', async () => {
    const repo = new InMemoryMaterialItemRepository();
    await expect(
      repo.create({ tenantId: 't1', description: 'bad qty', quantity: 0, createdBy: 'u1' }),
    ).rejects.toThrow(ValidationError);
    await expect(
      repo.create({ tenantId: 't1', description: 'bad qty', quantity: -1, createdBy: 'u1' }),
    ).rejects.toThrow(ValidationError);
  });

  it('rejects a non-integer quantity', async () => {
    const repo = new InMemoryMaterialItemRepository();
    await expect(
      repo.create({ tenantId: 't1', description: 'bad qty', quantity: 1.5, createdBy: 'u1' }),
    ).rejects.toThrow(ValidationError);
  });

  it('rejects a missing/blank description, tenantId, or createdBy', async () => {
    const repo = new InMemoryMaterialItemRepository();
    await expect(
      // @ts-expect-error -- deliberately omitting a required field
      repo.create({ tenantId: 't1', createdBy: 'u1' }),
    ).rejects.toThrow(ValidationError);
    await expect(
      repo.create({ tenantId: 't1', description: '   ', createdBy: 'u1' }),
    ).rejects.toThrow(ValidationError);
    await expect(
      // @ts-expect-error -- deliberately omitting a required field
      repo.create({ description: 'x', createdBy: 'u1' }),
    ).rejects.toThrow(ValidationError);
    await expect(
      // @ts-expect-error -- deliberately omitting a required field
      repo.create({ tenantId: 't1', description: 'x' }),
    ).rejects.toThrow(ValidationError);
  });

  describe('markPurchased', () => {
    it('transitions pending -> purchased, stamping purchasedBy/purchasedAt', async () => {
      const repo = new InMemoryMaterialItemRepository();
      const created = await repo.create({ tenantId: 't1', description: 'PEX', createdBy: 'u1' });
      const before = Date.now();
      const purchased = await repo.markPurchased('t1', created.id, 'u2');
      expect(purchased).not.toBeNull();
      expect(purchased!.status).toBe('purchased');
      expect(purchased!.purchasedBy).toBe('u2');
      expect(purchased!.purchasedAt).toBeInstanceOf(Date);
      expect(purchased!.purchasedAt!.getTime()).toBeGreaterThanOrEqual(before);
      expect(await repo.listPending('t1')).toHaveLength(0);
    });

    it('returns null for a nonexistent id', async () => {
      const repo = new InMemoryMaterialItemRepository();
      expect(await repo.markPurchased('t1', 'no-such-id', 'u1')).toBeNull();
    });

    it("returns null when the id belongs to a different tenant (no cross-tenant mutation)", async () => {
      const repo = new InMemoryMaterialItemRepository();
      const created = await repo.create({ tenantId: 't1', description: 'PEX', createdBy: 'u1' });
      expect(await repo.markPurchased('t2', created.id, 'u2')).toBeNull();
      // Untouched — still pending under its real tenant.
      expect(await repo.listPending('t1')).toHaveLength(1);
    });

    it('returns null on a second markPurchased call (no pending -> purchased -> purchased)', async () => {
      const repo = new InMemoryMaterialItemRepository();
      const created = await repo.create({ tenantId: 't1', description: 'PEX', createdBy: 'u1' });
      const first = await repo.markPurchased('t1', created.id, 'u2');
      expect(first).not.toBeNull();
      const second = await repo.markPurchased('t1', created.id, 'u3');
      expect(second).toBeNull();
      // The original purchase is left intact, not clobbered by the second actor.
      expect(first!.purchasedBy).toBe('u2');
    });
  });
});
