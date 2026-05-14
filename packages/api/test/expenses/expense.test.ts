import { describe, it, expect } from 'vitest';
import {
  validateCreateExpenseInput,
  createExpense,
  InMemoryExpenseRepository,
  EXPENSE_CATEGORIES,
} from '../../src/expenses/expense';

const baseInput = {
  tenantId: 't1',
  description: 'Copper fittings at supply house',
  amountCents: 24000,
  category: 'materials' as const,
  spentAt: new Date('2026-05-10T00:00:00.000Z'),
  createdBy: 'u1',
};

describe('validateCreateExpenseInput', () => {
  it('accepts a well-formed input', () => {
    expect(validateCreateExpenseInput(baseInput)).toEqual([]);
  });

  it('rejects a non-integer amount', () => {
    expect(validateCreateExpenseInput({ ...baseInput, amountCents: 240.5 })).toContain(
      'amountCents must be an integer',
    );
  });

  it('rejects a non-positive amount', () => {
    expect(validateCreateExpenseInput({ ...baseInput, amountCents: 0 })).toContain(
      'amountCents must be a positive number of cents',
    );
  });

  it('rejects an unknown category', () => {
    expect(
      validateCreateExpenseInput({ ...baseInput, category: 'snacks' as never }),
    ).toContain('category must be one of: ' + EXPENSE_CATEGORIES.join(', '));
  });

  it('rejects a blank description', () => {
    expect(validateCreateExpenseInput({ ...baseInput, description: '   ' })).toContain(
      'description is required',
    );
  });
});

describe('createExpense', () => {
  it('persists a row with generated id + timestamps', async () => {
    const repo = new InMemoryExpenseRepository();
    const expense = await createExpense({ ...baseInput, jobId: 'job1' }, repo);
    expect(expense.id).toMatch(/[0-9a-f-]{36}/);
    expect(expense.tenantId).toBe('t1');
    expect(expense.jobId).toBe('job1');
    expect(expense.amountCents).toBe(24000);
    expect(expense.createdAt).toBeInstanceOf(Date);
    const found = await repo.findById('t1', expense.id);
    expect(found?.description).toBe('Copper fittings at supply house');
  });

  it('throws on invalid input', async () => {
    const repo = new InMemoryExpenseRepository();
    await expect(createExpense({ ...baseInput, amountCents: -1 }, repo)).rejects.toThrow(
      /Validation failed/,
    );
  });
});

describe('InMemoryExpenseRepository.findByTenant', () => {
  it('filters by tenant, jobId, category and spentAt window', async () => {
    const repo = new InMemoryExpenseRepository();
    await createExpense({ ...baseInput, jobId: 'jobA', spentAt: new Date('2026-05-02') }, repo);
    await createExpense({ ...baseInput, category: 'fuel', spentAt: new Date('2026-05-20') }, repo);
    await createExpense({ ...baseInput, tenantId: 't2', spentAt: new Date('2026-05-10') }, repo);

    expect(await repo.findByTenant('t1')).toHaveLength(2);
    expect(await repo.findByTenant('t1', { jobId: 'jobA' })).toHaveLength(1);
    expect(await repo.findByTenant('t1', { category: 'fuel' })).toHaveLength(1);
    expect(
      await repo.findByTenant('t1', {
        from: new Date('2026-05-01'),
        to: new Date('2026-05-15'),
      }),
    ).toHaveLength(1);
  });
});
