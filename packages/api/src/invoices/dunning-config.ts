/**
 * P20-002 — Invoice dunning configuration + per-invoice dunning ledger.
 *
 * Two entities back the configurable collections cadence that the overdue
 * sweep (workers/overdue-invoice-worker.ts) walks in P20-003/004:
 *
 *  - DunningConfig: one row per tenant. An ordered list of reminder steps
 *    (offset days + channel) plus a late-fee policy (flat / percent / none,
 *    with grace + cap). All money is integer cents; percent fees are stored
 *    in basis points (bps), matching the billing engine's tax convention.
 *
 *  - DunningEvent: an idempotency ledger. One row per (invoice, kind, step)
 *    the worker has acted on. The DB enforces UNIQUE
 *    (tenant_id, invoice_id, kind, step_key); the in-memory repo mirrors
 *    the rule and raises a 23505-coded error so callers branch identically
 *    in tests and production — exactly like service_agreement_runs.
 */
import { v4 as uuidv4 } from 'uuid';

export type DunningChannel = 'sms' | 'email';
export type LateFeeType = 'none' | 'flat' | 'percent';
export type DunningEventKind = 'reminder' | 'late_fee';

/** One step in the ordered reminder cadence. */
export interface ReminderStep {
  /** Days after the invoice due date this reminder fires. */
  offsetDays: number;
  /** Channel the reminder is delivered on. */
  channel: DunningChannel;
}

export interface DunningConfig {
  id: string;
  tenantId: string;
  enabled: boolean;
  /** Ordered reminder cadence. Each step's identity is its (offsetDays, channel), not its position. */
  reminderSteps: ReminderStep[];
  lateFeeType: LateFeeType;
  /** flat: integer cents; percent: basis points of amount due. */
  lateFeeValueCents: number;
  /** Days past due before a late fee may accrue. */
  lateFeeGraceDays: number;
  /** Cap on accrued late fees, in cents. Null = uncapped. */
  lateFeeMaxCents?: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface DunningEvent {
  id: string;
  tenantId: string;
  invoiceId: string;
  kind: DunningEventKind;
  /**
   * Stable idempotency key for this step, unique per (invoice, kind). Reminders
   * use `reminderStepKey(step)` (`'<offsetDays>:<channel>'`) so the key survives
   * cadence reordering/edits; late fees use the accrual-period key supplied by
   * the worker (one-time fees use `LATE_FEE_ONE_TIME_KEY`).
   */
  stepKey: string;
  /** For late_fee events: the fee amount applied, in cents. */
  amountCents?: number;
  /** For reminder events: the channel it was sent on. */
  channel?: DunningChannel;
  sentAt: Date;
}

/**
 * Stable idempotency key for a reminder step, derived from its definition
 * (offset + channel) rather than its array position — so editing or reordering
 * the cadence never resends or skips an already-sent reminder.
 */
export function reminderStepKey(step: ReminderStep): string {
  return `${step.offsetDays}:${step.channel}`;
}

/**
 * Period key for a one-time late fee (one accrual per invoice). A future
 * recurring-late-fee policy passes a period bucket instead (e.g. '2026-02').
 */
export const LATE_FEE_ONE_TIME_KEY = 'initial';

/**
 * Minimum spacing between MANUAL (voice/on-demand) payment reminders for one
 * invoice, enforced at execution time by SendPaymentReminderExecutionHandler.
 * 72h is deliberately STRICTLY BELOW the default cadence's smallest inter-step
 * gap (defaultDunningConfig fires at 3/7/14 days → min gap 4 days), so this
 * manual cooldown never suppresses a legitimately-due cadence reminder — it
 * only stops a manual send from stacking on a very recent reminder (from
 * either the sweep or a prior manual send).
 */
export const PAYMENT_REMINDER_COOLDOWN_MS = 72 * 60 * 60 * 1000;

/**
 * Look-back window for the DRAFT-TIME duplicate-reminder marker (Layer 3).
 * When a resolved customer already received a reminder within this window, the
 * voice draft is annotated (confidence 'medium' + a marker) so the owner sees
 * "already reminded N days ago" before approving another. Advisory only — it
 * never blocks drafting or sending; the authoritative dedup is the 72h
 * execution-time cooldown above.
 */
export const DUNNING_MARKER_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Prefix for a manual reminder's dunning-ledger step key. Cadence reminders key
 * on `reminderStepKey` (`'<offsetDays>:<channel>'`); a manual/voice send keys on
 * `manualReminderStepKey(proposalId)` so the ledger row is unique per proposal
 * (making re-execution of the same approved proposal idempotent) yet still
 * distinguishable from a cadence step for the sweep's deferral check.
 */
export const MANUAL_REMINDER_STEP_PREFIX = 'manual:';

/**
 * The dunning-ledger step key for a manual reminder raised by proposal
 * `proposalId` (`'manual:<proposalId>'`). Unique per proposal so the
 * record-first ledger write is the idempotency anchor for a single approved
 * manual send.
 */
export function manualReminderStepKey(proposalId: string): string {
  return `${MANUAL_REMINDER_STEP_PREFIX}${proposalId}`;
}

/**
 * True when `stepKey` is a manual reminder ledger key (`manualReminderStepKey`
 * output). Used by the sweep to identify prior MANUAL reminders when deciding
 * whether to defer raising cadence reminders this pass. A cadence step key
 * (`'3:sms'`) or the payload discriminator `'manual'` (no colon) return false.
 */
export function isManualReminderStepKey(stepKey: string): boolean {
  return stepKey.startsWith(MANUAL_REMINDER_STEP_PREFIX);
}

/**
 * A tenant with no configured cadence gets this default: SMS reminders at
 * 3, 7, and 14 days overdue (PRD US-370), no late fee. Every step is raised
 * as an owner-approved `send_payment_reminder` proposal (the overdue sweep's
 * proposal-first design), so the day-14 reminder is already owner-reviewed
 * per US-372 — no separate auto-send path is introduced. The overdue sweep
 * falls back to this so dunning is never silently off for an overdue invoice.
 */
export function defaultDunningConfig(tenantId: string, now: Date = new Date()): DunningConfig {
  return {
    id: uuidv4(),
    tenantId,
    enabled: true,
    reminderSteps: [
      { offsetDays: 3, channel: 'sms' },
      { offsetDays: 7, channel: 'sms' },
      { offsetDays: 14, channel: 'sms' },
    ],
    lateFeeType: 'none',
    lateFeeValueCents: 0,
    lateFeeGraceDays: 0,
    lateFeeMaxCents: undefined,
    createdAt: now,
    updatedAt: now,
  };
}

export interface DunningConfigRepository {
  findByTenant(tenantId: string): Promise<DunningConfig | null>;
  /** Insert or replace the tenant's single config row. */
  upsert(config: DunningConfig): Promise<DunningConfig>;
}

export interface DunningEventRepository {
  /**
   * Insert a ledger row. Throws an error with `code === '23505'` when a row
   * already exists for (tenantId, invoiceId, kind, stepKey), so callers
   * can treat the race as a no-op exactly like service_agreement_runs.
   */
  create(event: DunningEvent): Promise<DunningEvent>;
  findByInvoice(tenantId: string, invoiceId: string): Promise<DunningEvent[]>;
  /**
   * Remove a specific ledger row by its natural key. Used to undo a
   * record-first reminder write when the send was suppressed at fire time
   * (I10 — the invoice was paid/void/zero-balance), so a suppressed reminder
   * never leaves a false "sent" row that would block a later legitimate
   * reminder inside the 72h cooldown. A no-op when no matching row exists.
   */
  deleteByInvoiceStep(
    tenantId: string,
    invoiceId: string,
    kind: DunningEvent['kind'],
    stepKey: string,
  ): Promise<void>;
}

export class InMemoryDunningConfigRepository implements DunningConfigRepository {
  private rows: Map<string, DunningConfig> = new Map();

  async findByTenant(tenantId: string): Promise<DunningConfig | null> {
    const r = this.rows.get(tenantId);
    return r ? { ...r, reminderSteps: r.reminderSteps.map((s) => ({ ...s })) } : null;
  }

  async upsert(config: DunningConfig): Promise<DunningConfig> {
    const stored: DunningConfig = {
      ...config,
      reminderSteps: config.reminderSteps.map((s) => ({ ...s })),
    };
    this.rows.set(config.tenantId, stored);
    return { ...stored, reminderSteps: stored.reminderSteps.map((s) => ({ ...s })) };
  }
}

export class InMemoryDunningEventRepository implements DunningEventRepository {
  private rows: Map<string, DunningEvent> = new Map();

  async create(event: DunningEvent): Promise<DunningEvent> {
    for (const existing of this.rows.values()) {
      if (
        existing.tenantId === event.tenantId &&
        existing.invoiceId === event.invoiceId &&
        existing.kind === event.kind &&
        existing.stepKey === event.stepKey
      ) {
        const err: Error & { code?: string } = new Error(
          `duplicate dunning event ${event.kind}:${event.stepKey} for invoice ${event.invoiceId}`,
        );
        err.code = '23505'; // PG unique_violation
        throw err;
      }
    }
    this.rows.set(event.id, this.clone(event));
    return this.clone(event);
  }

  async findByInvoice(tenantId: string, invoiceId: string): Promise<DunningEvent[]> {
    return Array.from(this.rows.values())
      .filter((r) => r.tenantId === tenantId && r.invoiceId === invoiceId)
      .sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime())
      .map((r) => this.clone(r));
  }

  async deleteByInvoiceStep(
    tenantId: string,
    invoiceId: string,
    kind: DunningEvent['kind'],
    stepKey: string,
  ): Promise<void> {
    for (const [id, r] of this.rows) {
      if (
        r.tenantId === tenantId &&
        r.invoiceId === invoiceId &&
        r.kind === kind &&
        r.stepKey === stepKey
      ) {
        this.rows.delete(id);
      }
    }
  }

  /** Deep-copy including the sentAt Date so stored state can't be mutated via a returned reference. */
  private clone(e: DunningEvent): DunningEvent {
    return { ...e, sentAt: new Date(e.sentAt) };
  }
}
