/**
 * P20-003 — Reminder cadence selection (pure).
 *
 * Decides which reminder steps are due for an overdue invoice right now,
 * given the tenant's cadence and the steps already sent (read from
 * invoice_dunning_events). Pure and I/O-free: the overdue sweep
 * (workers/overdue-invoice-worker.ts) calls this, sends each returned step
 * via the transactional-comms service, then records a dunning event per step
 * so a later sweep won't resend it.
 */
import { DunningConfig, ReminderStep } from './dunning-config';
import { daysPastDue } from './late-fee';

export interface ReminderSelectionInput {
  dueDate: Date;
  now: Date;
  /** Step indexes already sent (from invoice_dunning_events). */
  sentStepIndexes: number[];
}

export interface DueReminder {
  stepIndex: number;
  step: ReminderStep;
}

/**
 * Returns the reminder steps whose `offsetDays` have elapsed since the due
 * date and which have not already been sent, ordered by step index. Returns
 * an empty list when dunning is disabled or nothing is due yet.
 */
export function selectDueReminderSteps(
  config: DunningConfig,
  input: ReminderSelectionInput,
): DueReminder[] {
  if (!config.enabled) return [];

  const elapsed = daysPastDue(input.dueDate, input.now);
  const sent = new Set(input.sentStepIndexes);

  return config.reminderSteps
    .map((step, stepIndex) => ({ stepIndex, step }))
    .filter(({ stepIndex, step }) => !sent.has(stepIndex) && elapsed >= step.offsetDays)
    .sort((a, b) => a.stepIndex - b.stepIndex);
}
