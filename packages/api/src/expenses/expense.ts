import { v4 as uuidv4 } from 'uuid';
import { ValidationError } from '../shared/errors';

/**
 * Expense categories for lightweight bookkeeping (§8). Deliberately a
 * small, trade-relevant fixed set — this is tax-prep visibility, not a
 * full chart of accounts.
 */
export type ExpenseCategory =
  | 'materials'
  | 'fuel'
  | 'tools'
  | 'subcontractor'
  | 'vehicle'
  | 'insurance'
  | 'office'
  | 'other';

export const EXPENSE_CATEGORIES: ExpenseCategory[] = [
  'materials',
  'fuel',
  'tools',
  'subcontractor',
  'vehicle',
  'insurance',
  'office',
  'other',
];

export interface Expense {
  id: string;
  tenantId: string;
  /** Optional link to the job this expense was incurred for. */
  jobId?: string;
  description: string;
  /** Integer cents, always positive. */
  amountCents: number;
  category: ExpenseCategory;
  /** Free-text vendor / supply-house name. */
  vendor?: string;
  /** The date the money was spent (used for tax-period bucketing). */
  spentAt: Date;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateExpenseInput {
  tenantId: string;
  jobId?: string;
  description: string;
  amountCents: number;
  category: ExpenseCategory;
  vendor?: string;
  spentAt: Date;
  createdBy: string;
}

export interface ExpenseListOptions {
  jobId?: string;
  category?: ExpenseCategory;
  /** Inclusive lower bound on `spentAt`. */
  from?: Date;
  /** Exclusive upper bound on `spentAt`. */
  to?: Date;
}

export interface ExpenseRepository {
  create(expense: Expense): Promise<Expense>;
  findById(tenantId: string, id: string): Promise<Expense | null>;
  findByTenant(tenantId: string, options?: ExpenseListOptions): Promise<Expense[]>;
}

export function validateCreateExpenseInput(input: CreateExpenseInput): string[] {
  const errors: string[] = [];
  if (!input.tenantId) errors.push('tenantId is required');
  if (!input.createdBy) errors.push('createdBy is required');
  if (!input.description || input.description.trim().length === 0) {
    errors.push('description is required');
  }
  if (typeof input.amountCents !== 'number' || input.amountCents <= 0) {
    errors.push('amountCents must be a positive number of cents');
  } else if (!Number.isInteger(input.amountCents)) {
    errors.push('amountCents must be an integer');
  }
  if (!EXPENSE_CATEGORIES.includes(input.category)) {
    errors.push('category must be one of: ' + EXPENSE_CATEGORIES.join(', '));
  }
  if (!(input.spentAt instanceof Date) || Number.isNaN(input.spentAt.getTime())) {
    errors.push('spentAt must be a valid date');
  }
  return errors;
}

export async function createExpense(
  input: CreateExpenseInput,
  repo: ExpenseRepository,
): Promise<Expense> {
  const errors = validateCreateExpenseInput(input);
  if (errors.length > 0) {
    throw new ValidationError(`Validation failed: ${errors.join(', ')}`);
  }
  const now = new Date();
  const expense: Expense = {
    id: uuidv4(),
    tenantId: input.tenantId,
    ...(input.jobId ? { jobId: input.jobId } : {}),
    description: input.description.trim(),
    amountCents: input.amountCents,
    category: input.category,
    ...(input.vendor ? { vendor: input.vendor } : {}),
    spentAt: input.spentAt,
    createdBy: input.createdBy,
    createdAt: now,
    updatedAt: now,
  };
  return repo.create(expense);
}

export class InMemoryExpenseRepository implements ExpenseRepository {
  private expenses: Map<string, Expense> = new Map();

  async create(expense: Expense): Promise<Expense> {
    this.expenses.set(expense.id, { ...expense });
    return { ...expense };
  }

  async findById(tenantId: string, id: string): Promise<Expense | null> {
    const e = this.expenses.get(id);
    if (!e || e.tenantId !== tenantId) return null;
    return { ...e };
  }

  async findByTenant(tenantId: string, options?: ExpenseListOptions): Promise<Expense[]> {
    return Array.from(this.expenses.values())
      .filter((e) => e.tenantId === tenantId)
      .filter((e) => !options?.jobId || e.jobId === options.jobId)
      .filter((e) => !options?.category || e.category === options.category)
      .filter((e) => !options?.from || e.spentAt.getTime() >= options.from.getTime())
      .filter((e) => !options?.to || e.spentAt.getTime() < options.to.getTime())
      .map((e) => ({ ...e }));
  }
}
