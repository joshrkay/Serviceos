import { v4 as uuidv4 } from 'uuid';
import { Proposal, ProposalType } from '../proposal';
import { ExecutionContext, ExecutionHandler, ExecutionResult } from './handlers';
import {
  ExpenseRepository,
  ExpenseCategory,
  EXPENSE_CATEGORIES,
  createExpense,
} from '../../expenses/expense';
import { AuditRepository, createAuditEvent } from '../../audit/audit';

/**
 * Executes an approved `log_expense` proposal: persists an Expense row
 * and emits an `expense.logged` audit event. Follows the established
 * voice-handler pattern — when no `expenseRepo` is wired (in-memory unit
 * tests that don't exercise the mutation path) it degrades to a
 * synthetic-id passthrough. Audit emission is failure-soft: a logging
 * failure never unwinds a successful expense create.
 */
export class LogExpenseExecutionHandler implements ExecutionHandler {
  proposalType: ProposalType = 'log_expense';

  constructor(
    private readonly expenseRepo?: ExpenseRepository,
    private readonly auditRepo?: AuditRepository,
  ) {}

  async execute(proposal: Proposal, context: ExecutionContext): Promise<ExecutionResult> {
    const { payload } = proposal;
    const description = typeof payload.description === 'string' ? payload.description : '';
    const amountCents = typeof payload.amountCents === 'number' ? payload.amountCents : NaN;
    const category = payload.category as ExpenseCategory;
    const vendor = typeof payload.vendor === 'string' ? payload.vendor : undefined;
    const jobId = typeof payload.jobId === 'string' ? payload.jobId : undefined;

    if (!EXPENSE_CATEGORIES.includes(category)) {
      return { success: false, error: `Payload category must be one of: ${EXPENSE_CATEGORIES.join(', ')}` };
    }
    const spentAtRaw = typeof payload.spentAt === 'string' ? payload.spentAt : '';
    const spentAt = new Date(spentAtRaw);
    if (Number.isNaN(spentAt.getTime())) {
      return { success: false, error: 'Payload spentAt must be a parseable date string' };
    }

    if (!this.expenseRepo) {
      return { success: true, resultEntityId: uuidv4() };
    }

    let expenseId: string;
    try {
      const expense = await createExpense(
        {
          tenantId: context.tenantId,
          ...(jobId ? { jobId } : {}),
          description,
          amountCents,
          category,
          ...(vendor ? { vendor } : {}),
          spentAt,
          createdBy: context.executedBy,
        },
        this.expenseRepo,
      );
      expenseId = expense.id;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Failed to log expense: ${msg}` };
    }

    if (this.auditRepo) {
      try {
        await this.auditRepo.create(
          createAuditEvent({
            tenantId: context.tenantId,
            actorId: context.executedBy,
            actorRole: 'voice_agent',
            eventType: 'expense.logged',
            entityType: 'expense',
            entityId: expenseId,
            metadata: { proposalId: proposal.id, proposalType: 'log_expense', amountCents, category },
          }),
        );
      } catch {
        // Audit failures must not unwind a successful expense create.
      }
    }

    return { success: true, resultEntityId: expenseId };
  }
}
