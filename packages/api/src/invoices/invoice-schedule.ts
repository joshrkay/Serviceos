/**
 * P21-001 — Invoice schedules (progress / milestone billing).
 *
 * A schedule splits one job's total into ordered milestones — e.g. "50% deposit
 * on accept, 50% balance on completion" — each minted as its own invoice (the
 * deposit-credit path nets the deposit against the balance). This module owns
 * the data model + the pure money split; the `create_invoice_schedule` proposal
 * (P21-002) and the completion hook (P20-001) consume it.
 *
 * Money is integer cents; percent milestones are basis points (bps), matching
 * the billing engine's tax convention. A single `remainder` milestone absorbs
 * rounding so the milestone amounts always sum to exactly the total.
 */
import { v4 as uuidv4 } from 'uuid';
import { ValidationError } from '../shared/errors';
import { applyBps } from '../shared/billing-engine';

export const MILESTONE_TYPES = ['percent', 'flat', 'remainder'] as const;
export type MilestoneType = (typeof MILESTONE_TYPES)[number];

export const MILESTONE_TRIGGERS = ['on_accept', 'on_completion', 'manual'] as const;
export type MilestoneTrigger = (typeof MILESTONE_TRIGGERS)[number];

export interface InvoiceMilestone {
  label: string;
  type: MilestoneType;
  /**
   * percent: basis points (0–10000); flat: integer cents; remainder: ignored
   * (the milestone takes whatever is left so the split conserves the total).
   */
  value: number;
  /** When this milestone's invoice is minted. */
  trigger: MilestoneTrigger;
}

export interface InvoiceSchedule {
  id: string;
  tenantId: string;
  jobId: string;
  estimateId?: string;
  totalAmountCents: number;
  milestones: InvoiceMilestone[];
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

/** One milestone's resolved dollar amount, keyed back to its position + trigger. */
export interface MilestoneAllocation {
  index: number;
  label: string;
  trigger: MilestoneTrigger;
  amountCents: number;
}

/**
 * Validate a milestone list. Returns human-readable errors ([] = valid).
 * Mirrors the P21-002 Zod contract so the proposal layer and the data layer
 * agree: at least one milestone, exactly one `remainder`, percents in
 * [0, 10000] bps, flats are non-negative integer cents, labels non-empty.
 */
export function validateMilestones(milestones: InvoiceMilestone[]): string[] {
  const errors: string[] = [];
  if (!Array.isArray(milestones) || milestones.length === 0) {
    errors.push('At least one milestone is required');
    return errors;
  }

  const remainderCount = milestones.filter((m) => m.type === 'remainder').length;
  if (remainderCount !== 1) {
    errors.push(`Exactly one 'remainder' milestone is required (found ${remainderCount})`);
  }

  milestones.forEach((m, i) => {
    if (!m.label || m.label.trim().length === 0) {
      errors.push(`Milestone ${i} is missing a label`);
    }
    if (!MILESTONE_TYPES.includes(m.type)) {
      errors.push(`Milestone ${i} has an invalid type '${m.type}'`);
    }
    if (!MILESTONE_TRIGGERS.includes(m.trigger)) {
      errors.push(`Milestone ${i} has an invalid trigger '${m.trigger}'`);
    }
    if (m.type === 'percent') {
      if (!Number.isInteger(m.value) || m.value < 0 || m.value > 10000) {
        errors.push(`Milestone ${i} percent must be 0–10000 bps (got ${m.value})`);
      }
    } else if (m.type === 'flat') {
      if (!Number.isInteger(m.value) || m.value < 0) {
        errors.push(`Milestone ${i} flat amount must be a non-negative integer cents (got ${m.value})`);
      }
    }
  });

  // The percent milestones together can claim at most 100% of the total; the
  // single remainder absorbs the rest. Percents summing past 10000 bps would
  // drive the remainder negative — reject here (total-independent) rather than
  // only catching it in splitMilestones once the total is known.
  const percentBpsSum = milestones
    .filter((m) => m.type === 'percent')
    .reduce((sum, m) => sum + (Number.isInteger(m.value) ? m.value : 0), 0);
  if (percentBpsSum > 10000) {
    errors.push(`percent milestones sum to ${percentBpsSum} bps; cannot exceed 10000 (100%)`);
  }

  return errors;
}

/**
 * Split `totalCents` across the milestones, preserving order. Percent and flat
 * milestones take their computed amount; the single `remainder` milestone takes
 * whatever is left, so `Σ amountCents === totalCents` exactly (it absorbs
 * rounding). Throws `ValidationError` when the milestones are invalid or the
 * fixed (percent + flat) portions exceed the total.
 */
export function splitMilestones(
  totalCents: number,
  milestones: InvoiceMilestone[],
): MilestoneAllocation[] {
  if (!Number.isInteger(totalCents) || totalCents < 0) {
    throw new ValidationError(`totalCents must be a non-negative integer (got ${totalCents})`);
  }
  const errors = validateMilestones(milestones);
  if (errors.length > 0) {
    throw new ValidationError(`Invalid milestones: ${errors.join('; ')}`);
  }

  // First pass: fixed (non-remainder) amounts. percent uses the shared
  // billing engine so milestone rounding matches the rest of the document.
  const fixed = milestones.map((m) => {
    if (m.type === 'percent') return applyBps(totalCents, m.value);
    if (m.type === 'flat') return m.value;
    return 0; // remainder — resolved below
  });

  const allocatedFixed = fixed.reduce((sum, c, i) =>
    milestones[i].type === 'remainder' ? sum : sum + c, 0);
  if (allocatedFixed > totalCents) {
    throw new ValidationError(
      `Milestone amounts (${allocatedFixed}¢) exceed the schedule total (${totalCents}¢)`,
    );
  }

  const remainderCents = totalCents - allocatedFixed;

  return milestones.map((m, i) => ({
    index: i,
    label: m.label,
    trigger: m.trigger,
    amountCents: m.type === 'remainder' ? remainderCents : fixed[i],
  }));
}

export interface CreateInvoiceScheduleInput {
  tenantId: string;
  jobId: string;
  estimateId?: string;
  totalAmountCents: number;
  milestones: InvoiceMilestone[];
  createdBy: string;
}

/** Build a validated InvoiceSchedule entity (does not persist). */
export function buildInvoiceSchedule(
  input: CreateInvoiceScheduleInput,
  now: Date = new Date(),
): InvoiceSchedule {
  const errors = validateMilestones(input.milestones);
  if (errors.length > 0) {
    throw new ValidationError(`Invalid milestones: ${errors.join('; ')}`);
  }
  if (!Number.isInteger(input.totalAmountCents) || input.totalAmountCents < 0) {
    throw new ValidationError('totalAmountCents must be a non-negative integer');
  }
  return {
    id: uuidv4(),
    tenantId: input.tenantId,
    jobId: input.jobId,
    estimateId: input.estimateId,
    totalAmountCents: input.totalAmountCents,
    milestones: input.milestones.map((m) => ({ ...m })),
    createdBy: input.createdBy,
    createdAt: now,
    updatedAt: now,
  };
}

export interface InvoiceScheduleRepository {
  create(schedule: InvoiceSchedule): Promise<InvoiceSchedule>;
  findById(tenantId: string, id: string): Promise<InvoiceSchedule | null>;
  findByJob(tenantId: string, jobId: string): Promise<InvoiceSchedule[]>;
}

function clone(s: InvoiceSchedule): InvoiceSchedule {
  return { ...s, milestones: s.milestones.map((m) => ({ ...m })) };
}

export class InMemoryInvoiceScheduleRepository implements InvoiceScheduleRepository {
  private rows: Map<string, InvoiceSchedule> = new Map();

  async create(schedule: InvoiceSchedule): Promise<InvoiceSchedule> {
    this.rows.set(schedule.id, clone(schedule));
    return clone(schedule);
  }

  async findById(tenantId: string, id: string): Promise<InvoiceSchedule | null> {
    const r = this.rows.get(id);
    return r && r.tenantId === tenantId ? clone(r) : null;
  }

  async findByJob(tenantId: string, jobId: string): Promise<InvoiceSchedule[]> {
    return [...this.rows.values()]
      .filter((r) => r.tenantId === tenantId && r.jobId === jobId)
      .map(clone);
  }
}
