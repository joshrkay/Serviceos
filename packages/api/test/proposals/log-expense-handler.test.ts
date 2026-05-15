import { describe, it, expect } from 'vitest';
import {
  VALID_PROPOSAL_TYPES,
  actionClassForProposalType,
} from '../../src/proposals/proposal';
import { validateProposalPayload } from '../../src/proposals/contracts';
import { LogExpenseExecutionHandler } from '../../src/proposals/execution/log-expense-handler';
import { InMemoryExpenseRepository } from '../../src/expenses/expense';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import type { Proposal } from '../../src/proposals/proposal';

function makeProposal(payload: Record<string, unknown>): Proposal {
  const now = new Date();
  return {
    id: 'prop-1',
    tenantId: 't1',
    proposalType: 'log_expense',
    status: 'approved',
    payload,
    summary: 'Log expense',
    createdBy: 'u1',
    createdAt: now,
    updatedAt: now,
  };
}

describe('log_expense proposal type', () => {
  it('is a valid proposal type classified as capture', () => {
    expect(VALID_PROPOSAL_TYPES).toContain('log_expense');
    expect(actionClassForProposalType('log_expense')).toBe('capture');
  });

  it('accepts a well-formed payload', () => {
    const result = validateProposalPayload('log_expense', {
      description: '$240 at the supply house',
      amountCents: 24000,
      category: 'materials',
      spentAt: '2026-05-10',
      jobId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
    });
    expect(result.valid).toBe(true);
  });

  it('rejects a payload with a fractional amount', () => {
    const result = validateProposalPayload('log_expense', {
      description: 'fuel',
      amountCents: 12.5,
      category: 'fuel',
      spentAt: '2026-05-10',
    });
    expect(result.valid).toBe(false);
  });

  it('rejects a payload with an unknown category', () => {
    const result = validateProposalPayload('log_expense', {
      description: 'mystery',
      amountCents: 100,
      category: 'snacks',
      spentAt: '2026-05-10',
    });
    expect(result.valid).toBe(false);
  });
});

describe('LogExpenseExecutionHandler', () => {
  const ctx = { tenantId: 't1', executedBy: 'u1' };
  const goodPayload = {
    description: '$240 at the supply house',
    amountCents: 24000,
    category: 'materials',
    spentAt: '2026-05-10',
    jobId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
  };

  it('persists an expense row + emits an audit event when wired', async () => {
    const expenseRepo = new InMemoryExpenseRepository();
    const auditRepo = new InMemoryAuditRepository();
    const handler = new LogExpenseExecutionHandler(expenseRepo, auditRepo);
    const result = await handler.execute(makeProposal(goodPayload), ctx);
    expect(result.success).toBe(true);
    expect(result.resultEntityId).toBeDefined();
    const stored = await expenseRepo.findById('t1', result.resultEntityId!);
    expect(stored?.amountCents).toBe(24000);
    expect(stored?.category).toBe('materials');
    const events = auditRepo.getAll();
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('expense.logged');
    expect(events[0].entityId).toBe(result.resultEntityId);
  });

  it('degrades to a synthetic-id passthrough when no repo is wired', async () => {
    const handler = new LogExpenseExecutionHandler();
    const result = await handler.execute(makeProposal(goodPayload), ctx);
    expect(result.success).toBe(true);
    expect(result.resultEntityId).toMatch(/[0-9a-f-]{36}/);
  });

  it('fails cleanly on an invalid payload', async () => {
    const handler = new LogExpenseExecutionHandler(new InMemoryExpenseRepository());
    const result = await handler.execute(
      makeProposal({ description: 'x', amountCents: -1, category: 'materials', spentAt: '2026-05-10' }),
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/amountCents/);
  });

  it('fails cleanly on an unparseable spentAt', async () => {
    const handler = new LogExpenseExecutionHandler(new InMemoryExpenseRepository());
    const result = await handler.execute(
      makeProposal({ ...goodPayload, spentAt: 'not-a-date' }),
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/spentAt/);
  });
});
