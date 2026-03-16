import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';

export interface TechnicianWorkingHours {
  id: string;
  tenantId: string;
  technicianId: string;
  dayOfWeek: number; // 0 (Sunday) through 6 (Saturday)
  startTime: string; // HH:mm format
  endTime: string;   // HH:mm format
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateWorkingHoursInput {
  tenantId: string;
  technicianId: string;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  isActive?: boolean;
}

const TIME_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;

export const workingHoursSchema = z.object({
  tenantId: z.string().uuid(),
  technicianId: z.string().uuid(),
  dayOfWeek: z.number().int().min(0).max(6),
  startTime: z.string().regex(TIME_REGEX, 'Must be in HH:mm format'),
  endTime: z.string().regex(TIME_REGEX, 'Must be in HH:mm format'),
  isActive: z.boolean().optional(),
});

export function validateWorkingHoursInput(input: CreateWorkingHoursInput): string[] {
  const result = workingHoursSchema.safeParse(input);
  if (!result.success) {
    return result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
  }

  const errors: string[] = [];
  if (input.startTime >= input.endTime) {
    errors.push('startTime must be before endTime');
  }
  return errors;
}

export interface WorkingHoursRepository {
  create(hours: TechnicianWorkingHours): Promise<TechnicianWorkingHours>;
  findByTechnician(tenantId: string, technicianId: string): Promise<TechnicianWorkingHours[]>;
  findByTechnicianAndDay(tenantId: string, technicianId: string, dayOfWeek: number): Promise<TechnicianWorkingHours | null>;
  update(tenantId: string, id: string, updates: Partial<TechnicianWorkingHours>): Promise<TechnicianWorkingHours | null>;
  delete(tenantId: string, id: string): Promise<boolean>;
}

export function createWorkingHours(input: CreateWorkingHoursInput): TechnicianWorkingHours {
  const errors = validateWorkingHoursInput(input);
  if (errors.length > 0) throw new Error(`Validation failed: ${errors.join(', ')}`);

  const now = new Date();
  return {
    id: uuidv4(),
    tenantId: input.tenantId,
    technicianId: input.technicianId,
    dayOfWeek: input.dayOfWeek,
    startTime: input.startTime,
    endTime: input.endTime,
    isActive: input.isActive ?? true,
    createdAt: now,
    updatedAt: now,
  };
}

export class InMemoryWorkingHoursRepository implements WorkingHoursRepository {
  private hours: Map<string, TechnicianWorkingHours> = new Map();

  async create(hours: TechnicianWorkingHours): Promise<TechnicianWorkingHours> {
    this.hours.set(hours.id, { ...hours });
    return { ...hours };
  }

  async findByTechnician(tenantId: string, technicianId: string): Promise<TechnicianWorkingHours[]> {
    return Array.from(this.hours.values())
      .filter((h) => h.tenantId === tenantId && h.technicianId === technicianId)
      .map((h) => ({ ...h }));
  }

  async findByTechnicianAndDay(tenantId: string, technicianId: string, dayOfWeek: number): Promise<TechnicianWorkingHours | null> {
    const found = Array.from(this.hours.values()).find(
      (h) => h.tenantId === tenantId && h.technicianId === technicianId && h.dayOfWeek === dayOfWeek
    );
    return found ? { ...found } : null;
  }

  async update(tenantId: string, id: string, updates: Partial<TechnicianWorkingHours>): Promise<TechnicianWorkingHours | null> {
    const existing = this.hours.get(id);
    if (!existing || existing.tenantId !== tenantId) return null;
    const updated = { ...existing, ...updates, updatedAt: new Date() };
    this.hours.set(id, updated);
    return { ...updated };
  }

  async delete(tenantId: string, id: string): Promise<boolean> {
    const existing = this.hours.get(id);
    if (!existing || existing.tenantId !== tenantId) return false;
    this.hours.delete(id);
    return true;
  }
}
