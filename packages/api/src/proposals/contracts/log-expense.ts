import { z } from 'zod';
import { EXPENSE_CATEGORIES } from '../../expenses/expense';

/**
 * log_expense proposal payload (§8).
 *
 * Captures a business expense the owner logged by voice ("$240 at the
 * supply house for the Johnson job"). Capture-class — it records a
 * real-world event, moves no money, and is reversible. Amount is
 * integer cents (CLAUDE.md core patterns).
 *
 * `spentAt` is an ISO date string ('YYYY-MM-DD' or a full ISO
 * timestamp); the execution handler parses it to a Date.
 */
export const logExpensePayloadSchema = z.object({
  description: z.string().min(1).max(1000),
  amountCents: z.number().int().positive(),
  category: z.enum([...EXPENSE_CATEGORIES] as [string, ...string[]]),
  vendor: z.string().max(200).optional(),
  spentAt: z.string().min(1).max(64),
  jobId: z.string().uuid().optional(),
});

export type LogExpensePayload = z.infer<typeof logExpensePayloadSchema>;
