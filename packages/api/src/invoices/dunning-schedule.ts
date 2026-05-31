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
import { DunningConfig, ReminderStep, reminderStepKey } from './dunning-config';
import { daysPastDue } from './late-fee';

export interface ReminderSelectionInput {
  dueDate: Date;
  now: Date;
  /** Stable step keys already sent (from invoice_dunning_events.step_key). */
  sentStepKeys: string[];
}

export interface DueReminder {
  /** Stable idempotency key for the step (see reminderStepKey). */
  stepKey: string;
  step: ReminderStep;
}

/**
 * Returns the reminder steps whose `offsetDays` have elapsed since the due
 * date and which have not already been sent, ordered chronologically by
 * `offsetDays`. Each step is identified by a stable key derived from its
 * definition (not its array position), so editing the cadence never resends
 * or skips a reminder. Returns an empty list when dunning is disabled or
 * nothing is due yet.
 */
export function selectDueReminderSteps(
  config: DunningConfig,
  input: ReminderSelectionInput,
): DueReminder[] {
  if (!config.enabled) return [];

  const elapsed = daysPastDue(input.dueDate, input.now);
  const sent = new Set(input.sentStepKeys);

  return config.reminderSteps
    .map((step) => ({ stepKey: reminderStepKey(step), step }))
    .filter(({ stepKey, step }) => !sent.has(stepKey) && elapsed >= step.offsetDays)
    .sort((a, b) => a.step.offsetDays - b.step.offsetDays);
}
