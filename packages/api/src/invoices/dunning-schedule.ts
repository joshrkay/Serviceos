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
  const seen = new Set<string>();
  const due: DueReminder[] = [];

  for (const step of config.reminderSteps) {
    // Defense-in-depth until reminder cadences are validated at the write path:
    // ignore non-integer or negative offsets (a dunning reminder must never fire
    // before the invoice is overdue), and collapse duplicate step definitions so
    // a single sweep can't double-send under one stable key.
    if (!Number.isInteger(step.offsetDays) || step.offsetDays < 0) continue;
    const stepKey = reminderStepKey(step);
    if (sent.has(stepKey) || seen.has(stepKey)) continue;
    if (elapsed < step.offsetDays) continue;
    seen.add(stepKey);
    due.push({ stepKey, step });
  }

  return due.sort((a, b) => a.step.offsetDays - b.step.offsetDays);
}
