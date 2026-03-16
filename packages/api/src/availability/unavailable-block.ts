import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';

export interface UnavailableBlock {
  id: string;
  tenantId: string;
  technicianId: string;
  startTime: Date;
  endTime: Date;
  reason?: string;
  createdBy: string;
  createdAt: Date;
}

export interface CreateUnavailableBlockInput {
  tenantId: string;
  technicianId: string;
  startTime: Date;
  endTime: Date;
  reason?: string;
  createdBy: string;
}

export const unavailableBlockSchema = z.object({
  tenantId: z.string().uuid(),
  technicianId: z.string().uuid(),
  startTime: z.date(),
  endTime: z.date(),
  reason: z.string().optional(),
  createdBy: z.string().min(1),
});

export function validateUnavailableBlockInput(input: CreateUnavailableBlockInput): string[] {
  const errors: string[] = [];

  if (!input.tenantId) errors.push('tenantId is required');
  if (!input.technicianId) errors.push('technicianId is required');
  if (!input.startTime) errors.push('startTime is required');
  if (!input.endTime) errors.push('endTime is required');
  if (!input.createdBy) errors.push('createdBy is required');

  if (input.startTime && input.endTime && input.startTime >= input.endTime) {
    errors.push('startTime must be before endTime');
  }

  return errors;
}

export interface UnavailableBlockRepository {
  create(block: UnavailableBlock): Promise<UnavailableBlock>;
  findByTechnician(tenantId: string, technicianId: string): Promise<UnavailableBlock[]>;
  findByTechnicianAndDateRange(tenantId: string, technicianId: string, start: Date, end: Date): Promise<UnavailableBlock[]>;
  delete(tenantId: string, id: string): Promise<boolean>;
}

export function createUnavailableBlock(input: CreateUnavailableBlockInput): UnavailableBlock {
  const errors = validateUnavailableBlockInput(input);
  if (errors.length > 0) throw new Error(`Validation failed: ${errors.join(', ')}`);

  return {
    id: uuidv4(),
    tenantId: input.tenantId,
    technicianId: input.technicianId,
    startTime: input.startTime,
    endTime: input.endTime,
    reason: input.reason,
    createdBy: input.createdBy,
    createdAt: new Date(),
  };
}

export class InMemoryUnavailableBlockRepository implements UnavailableBlockRepository {
  private blocks: Map<string, UnavailableBlock> = new Map();

  async create(block: UnavailableBlock): Promise<UnavailableBlock> {
    this.blocks.set(block.id, { ...block });
    return { ...block };
  }

  async findByTechnician(tenantId: string, technicianId: string): Promise<UnavailableBlock[]> {
    return Array.from(this.blocks.values())
      .filter((b) => b.tenantId === tenantId && b.technicianId === technicianId)
      .map((b) => ({ ...b }));
  }

  async findByTechnicianAndDateRange(
    tenantId: string,
    technicianId: string,
    start: Date,
    end: Date,
  ): Promise<UnavailableBlock[]> {
    return Array.from(this.blocks.values())
      .filter((b) =>
        b.tenantId === tenantId &&
        b.technicianId === technicianId &&
        b.startTime < end &&
        b.endTime > start
      )
      .map((b) => ({ ...b }));
  }

  async delete(tenantId: string, id: string): Promise<boolean> {
    const block = this.blocks.get(id);
    if (!block || block.tenantId !== tenantId) return false;
    this.blocks.delete(id);
    return true;
  }
}
