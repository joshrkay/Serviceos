import { describe, it, expect, beforeEach } from 'vitest';
import {
  createUnavailableBlock,
  validateUnavailableBlockInput,
  InMemoryUnavailableBlockRepository,
} from '../../src/availability/unavailable-block';

describe('P6-015B — Technician unavailable-block model', () => {
  let repo: InMemoryUnavailableBlockRepository;

  const tenantId = '550e8400-e29b-41d4-a716-446655440000';
  const techId = '660e8400-e29b-41d4-a716-446655440001';

  const validInput = {
    tenantId,
    technicianId: techId,
    startTime: new Date('2026-03-14T12:00:00Z'),
    endTime: new Date('2026-03-14T13:00:00Z'),
    reason: 'Lunch break',
    createdBy: 'user-1',
  };

  beforeEach(() => {
    repo = new InMemoryUnavailableBlockRepository();
  });

  it('creates an unavailable block with valid input', () => {
    const block = createUnavailableBlock(validInput);
    expect(block.id).toBeDefined();
    expect(block.tenantId).toBe(tenantId);
    expect(block.technicianId).toBe(techId);
    expect(block.reason).toBe('Lunch break');
  });

  it('rejects invalid input — startTime after endTime', () => {
    const errors = validateUnavailableBlockInput({
      ...validInput,
      startTime: new Date('2026-03-14T13:00:00Z'),
      endTime: new Date('2026-03-14T12:00:00Z'),
    });
    expect(errors).toContain('startTime must be before endTime');
  });

  it('rejects invalid input — missing createdBy', () => {
    const errors = validateUnavailableBlockInput({ ...validInput, createdBy: '' });
    expect(errors).toContain('createdBy is required');
  });

  it('stores and retrieves by technician', async () => {
    const block = createUnavailableBlock(validInput);
    await repo.create(block);
    const found = await repo.findByTechnician(tenantId, techId);
    expect(found).toHaveLength(1);
  });

  it('retrieves by date range — overlapping', async () => {
    const block = createUnavailableBlock(validInput);
    await repo.create(block);

    const found = await repo.findByTechnicianAndDateRange(
      tenantId, techId,
      new Date('2026-03-14T00:00:00Z'),
      new Date('2026-03-14T23:59:59Z'),
    );
    expect(found).toHaveLength(1);
  });

  it('does not return blocks outside date range', async () => {
    const block = createUnavailableBlock(validInput);
    await repo.create(block);

    const found = await repo.findByTechnicianAndDateRange(
      tenantId, techId,
      new Date('2026-03-15T00:00:00Z'),
      new Date('2026-03-15T23:59:59Z'),
    );
    expect(found).toHaveLength(0);
  });

  it('deletes unavailable block', async () => {
    const block = createUnavailableBlock(validInput);
    await repo.create(block);
    const deleted = await repo.delete(tenantId, block.id);
    expect(deleted).toBe(true);
    const found = await repo.findByTechnician(tenantId, techId);
    expect(found).toHaveLength(0);
  });

  it('enforces tenant isolation', async () => {
    const block = createUnavailableBlock(validInput);
    await repo.create(block);
    const found = await repo.findByTechnician('other-tenant', techId);
    expect(found).toHaveLength(0);
  });

  it('enforces tenant isolation on delete', async () => {
    const block = createUnavailableBlock(validInput);
    await repo.create(block);
    const deleted = await repo.delete('other-tenant', block.id);
    expect(deleted).toBe(false);
  });
});
