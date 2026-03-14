import { describe, it, expect, beforeEach } from 'vitest';
import {
  createWorkingHours,
  validateWorkingHoursInput,
  InMemoryWorkingHoursRepository,
  TechnicianWorkingHours,
} from '../../src/availability/working-hours';

describe('P6-015A — Technician working-hours model', () => {
  let repo: InMemoryWorkingHoursRepository;

  const validInput = {
    tenantId: '550e8400-e29b-41d4-a716-446655440000',
    technicianId: '660e8400-e29b-41d4-a716-446655440001',
    dayOfWeek: 1, // Monday
    startTime: '08:00',
    endTime: '17:00',
  };

  beforeEach(() => {
    repo = new InMemoryWorkingHoursRepository();
  });

  it('creates working hours with valid input', () => {
    const hours = createWorkingHours(validInput);
    expect(hours.id).toBeDefined();
    expect(hours.tenantId).toBe(validInput.tenantId);
    expect(hours.technicianId).toBe(validInput.technicianId);
    expect(hours.dayOfWeek).toBe(1);
    expect(hours.startTime).toBe('08:00');
    expect(hours.endTime).toBe('17:00');
    expect(hours.isActive).toBe(true);
  });

  it('rejects invalid input — startTime after endTime', () => {
    const errors = validateWorkingHoursInput({
      ...validInput,
      startTime: '17:00',
      endTime: '08:00',
    });
    expect(errors).toContain('startTime must be before endTime');
  });

  it('rejects invalid input — dayOfWeek out of range', () => {
    const errors = validateWorkingHoursInput({ ...validInput, dayOfWeek: 7 });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects invalid input — bad time format', () => {
    const errors = validateWorkingHoursInput({ ...validInput, startTime: '8am' });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects invalid input — missing tenantId', () => {
    const errors = validateWorkingHoursInput({ ...validInput, tenantId: '' });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('stores and retrieves by technician', async () => {
    const hours = createWorkingHours(validInput);
    await repo.create(hours);
    const found = await repo.findByTechnician(validInput.tenantId, validInput.technicianId);
    expect(found).toHaveLength(1);
    expect(found[0].dayOfWeek).toBe(1);
  });

  it('retrieves by technician and day', async () => {
    const hours = createWorkingHours(validInput);
    await repo.create(hours);
    const found = await repo.findByTechnicianAndDay(validInput.tenantId, validInput.technicianId, 1);
    expect(found).not.toBeNull();
    expect(found!.startTime).toBe('08:00');
  });

  it('returns null for non-existent day', async () => {
    const found = await repo.findByTechnicianAndDay(validInput.tenantId, validInput.technicianId, 3);
    expect(found).toBeNull();
  });

  it('updates working hours', async () => {
    const hours = createWorkingHours(validInput);
    await repo.create(hours);
    const updated = await repo.update(validInput.tenantId, hours.id, { endTime: '18:00' });
    expect(updated).not.toBeNull();
    expect(updated!.endTime).toBe('18:00');
  });

  it('deletes working hours', async () => {
    const hours = createWorkingHours(validInput);
    await repo.create(hours);
    const deleted = await repo.delete(validInput.tenantId, hours.id);
    expect(deleted).toBe(true);
    const found = await repo.findByTechnician(validInput.tenantId, validInput.technicianId);
    expect(found).toHaveLength(0);
  });

  it('enforces tenant isolation on findByTechnician', async () => {
    const hours = createWorkingHours(validInput);
    await repo.create(hours);
    const found = await repo.findByTechnician('other-tenant-id', validInput.technicianId);
    expect(found).toHaveLength(0);
  });

  it('enforces tenant isolation on delete', async () => {
    const hours = createWorkingHours(validInput);
    await repo.create(hours);
    const deleted = await repo.delete('other-tenant-id', hours.id);
    expect(deleted).toBe(false);
  });
});
