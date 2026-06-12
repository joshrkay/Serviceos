/**
 * RV-085 — `lookup_pending_items` voice skill ("what am I waiting on?").
 *
 * Owner-scoped, read-only — bypasses proposals like every lookup_* skill.
 * Composes three "waiting on the other side" buckets:
 *
 *   1. aging SENT-but-unaccepted estimates (age in days since sentAt),
 *   2. open / partially-paid invoices, split owing vs overdue using the
 *      money dashboard's own predicates, with the dunning stage
 *      ("reminder N of M") when a DunningConfigRepository is wired —
 *      the stage is derived purely from days-past-due against the
 *      tenant's cadence, so it costs one config read, no event scan,
 *   3. unanswered dropped-call recovery threads via an optional
 *      read-only port (`listUnansweredRecoveries`) — the recovery repo
 *      (src/sms/recovery/scheduler.ts) exposes no tenant-list read and
 *      is owned by another track, so the caller supplies the query and
 *      this skill only speaks the result. Absent port → bucket omitted.
 */
import type { Estimate, EstimateRepository } from '../../estimates/estimate';
import type { Invoice, InvoiceRepository } from '../../invoices/invoice';
import type { DunningConfigRepository } from '../../invoices/dunning-config';
import { daysPastDue } from '../../invoices/late-fee';
import { isInvoiceOverdue, isInvoiceOwing } from '../../reports/money-dashboard';
import type { DroppedCallRecoveryRow } from '../../sms/recovery/scheduler';
import type { LookupEventService } from '../../lookup-events/lookup-event-service';

export interface LookupPendingItemsInput {
  tenantId: string;
  /** Injectable clock — pinned by tests. Defaults to now. */
  now?: Date;
  /** Voice session this lookup runs inside. Used for the audit row. */
  sessionId?: string;
}

export interface LookupPendingItemsDeps {
  estimateRepo: EstimateRepository;
  invoiceRepo: InvoiceRepository;
  /** Optional — enables the spoken dunning stage on overdue invoices. */
  dunningConfigRepo?: DunningConfigRepository;
  /** Optional read-only port: sent recovery SMS threads with no reply yet. */
  listUnansweredRecoveries?: (tenantId: string) => Promise<DroppedCallRecoveryRow[]>;
  /** Optional — when wired the skill writes a `lookup_events` audit row. */
  lookupEvents?: LookupEventService;
}

export interface PendingEstimateItem {
  estimateId: string;
  estimateNumber: string;
  totalCents: number;
  /** Whole days since first send (0 when sent today / sentAt missing). */
  ageDays: number;
}

export interface PendingInvoiceItem {
  invoiceId: string;
  invoiceNumber: string;
  amountDueCents: number;
  overdue: boolean;
  /** Days past the due date (0 when not overdue / no due date). */
  daysPastDue: number;
  /** "reminder 2 of 3" — present only when overdue AND dunning is resolvable. */
  dunningStage?: string;
}

export type LookupPendingItemsResult =
  | {
      status: 'found' | 'none';
      summary: string;
      data: {
        estimates: PendingEstimateItem[];
        invoices: PendingInvoiceItem[];
        /** undefined when no recovery port is wired (bucket not spoken). */
        unansweredRecoveryCount?: number;
      };
    }
  | { status: 'error'; summary: string; data: { error: string } };

/** Spoken caps so a backlog never becomes a monologue. */
const MAX_SPOKEN_ESTIMATES = 3;
const MAX_SPOKEN_INVOICES = 3;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function wholeDaysSince(d: Date | undefined, now: Date): number {
  if (!d) return 0;
  const diff = now.getTime() - d.getTime();
  return diff <= 0 ? 0 : Math.floor(diff / MS_PER_DAY);
}

function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function agePhrase(days: number): string {
  if (days === 0) return 'sent today';
  return `sent ${days} ${days === 1 ? 'day' : 'days'} ago`;
}

function plural(n: number, singular: string, pluralForm?: string): string {
  return n === 1 ? singular : (pluralForm ?? `${singular}s`);
}

export async function lookupPendingItems(
  input: LookupPendingItemsInput,
  deps: LookupPendingItemsDeps,
): Promise<LookupPendingItemsResult> {
  const start = Date.now();
  const now = input.now ?? new Date();

  const recordEvent = async (
    resultStatus: 'found' | 'none' | 'error',
    resultCount: number,
    summary: string,
  ): Promise<void> => {
    if (!deps.lookupEvents) return;
    try {
      await deps.lookupEvents.record({
        tenantId: input.tenantId,
        intent: 'lookup_pending_items',
        sessionId: input.sessionId,
        latencyMs: Date.now() - start,
        resultStatus,
        resultCount,
        summary,
      });
    } catch {
      // best-effort: skill must never fail on audit write
    }
  };

  try {
    const [sentEstimates, openInvoices, partiallyPaidInvoices] = await Promise.all([
      deps.estimateRepo.findByTenant(input.tenantId, { status: 'sent' }),
      deps.invoiceRepo.findByTenant(input.tenantId, { status: 'open' }),
      deps.invoiceRepo.findByTenant(input.tenantId, { status: 'partially_paid' }),
    ]);

    // Dunning config — one read, decorative on failure.
    let dunningStageFor: ((inv: Invoice) => string | undefined) | undefined;
    if (deps.dunningConfigRepo) {
      try {
        const config = await deps.dunningConfigRepo.findByTenant(input.tenantId);
        if (config?.enabled && config.reminderSteps.length > 0) {
          const totalSteps = config.reminderSteps.length;
          dunningStageFor = (inv: Invoice) => {
            if (!inv.dueDate) return undefined;
            const elapsed = daysPastDue(inv.dueDate, now);
            const stage = config.reminderSteps.filter(
              (s) => Number.isInteger(s.offsetDays) && s.offsetDays >= 0 && s.offsetDays <= elapsed,
            ).length;
            return stage > 0 ? `reminder ${stage} of ${totalSteps}` : undefined;
          };
        }
      } catch {
        // Stage is decorative — never fail the lookup over it.
      }
    }

    const estimates: PendingEstimateItem[] = sentEstimates
      .filter((e: Estimate) => !e.acceptedAt && !e.rejectedAt)
      .map((e) => ({
        estimateId: e.id,
        estimateNumber: e.estimateNumber,
        totalCents: e.totals.totalCents,
        ageDays: wholeDaysSince(e.sentAt, now),
      }))
      .sort((a, b) => b.ageDays - a.ageDays);

    const invoices: PendingInvoiceItem[] = [...openInvoices, ...partiallyPaidInvoices]
      .filter((i) => isInvoiceOwing(i))
      .map((i) => {
        const overdue = isInvoiceOverdue(i, now);
        const dunningStage = overdue && dunningStageFor ? dunningStageFor(i) : undefined;
        return {
          invoiceId: i.id,
          invoiceNumber: i.invoiceNumber,
          amountDueCents: i.amountDueCents,
          overdue,
          daysPastDue: i.dueDate ? daysPastDue(i.dueDate, now) : 0,
          ...(dunningStage ? { dunningStage } : {}),
        };
      })
      // Overdue first, then most days past due, then largest amount.
      .sort((a, b) => {
        if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
        if (a.daysPastDue !== b.daysPastDue) return b.daysPastDue - a.daysPastDue;
        return b.amountDueCents - a.amountDueCents;
      });

    let unansweredRecoveryCount: number | undefined;
    if (deps.listUnansweredRecoveries) {
      try {
        const threads = await deps.listUnansweredRecoveries(input.tenantId);
        // Explicit tenant predicate — defense in depth on top of the port.
        unansweredRecoveryCount = threads.filter((t) => t.tenantId === input.tenantId).length;
      } catch {
        // Recovery bucket is best-effort — omit on failure.
      }
    }

    // ── Spoken summary ──
    const sentences: string[] = [];

    if (estimates.length > 0) {
      const spoken = estimates
        .slice(0, MAX_SPOKEN_ESTIMATES)
        .map((e) => `${e.estimateNumber} for ${formatUsd(e.totalCents)}, ${agePhrase(e.ageDays)}`)
        .join('; ');
      const rest = estimates.length - Math.min(estimates.length, MAX_SPOKEN_ESTIMATES);
      sentences.push(
        `${estimates.length} ${plural(estimates.length, 'estimate is', 'estimates are')} out waiting on a yes: ` +
          `${spoken}${rest > 0 ? `; plus ${rest} more` : ''}.`,
      );
    }

    if (invoices.length > 0) {
      const overdueCount = invoices.filter((i) => i.overdue).length;
      const spoken = invoices
        .slice(0, MAX_SPOKEN_INVOICES)
        .map((i) => {
          const state = i.overdue
            ? `${i.daysPastDue} ${plural(i.daysPastDue, 'day')} overdue${i.dunningStage ? `, ${i.dunningStage}` : ''}`
            : 'open';
          return `${i.invoiceNumber} for ${formatUsd(i.amountDueCents)} (${state})`;
        })
        .join('; ');
      const rest = invoices.length - Math.min(invoices.length, MAX_SPOKEN_INVOICES);
      sentences.push(
        `${invoices.length} unpaid ${plural(invoices.length, 'invoice')}` +
          `${overdueCount > 0 ? `, ${overdueCount} overdue` : ''}: ` +
          `${spoken}${rest > 0 ? `; plus ${rest} more` : ''}.`,
      );
    }

    if (unansweredRecoveryCount !== undefined && unansweredRecoveryCount > 0) {
      sentences.push(
        `${unansweredRecoveryCount} dropped-call recovery ${plural(unansweredRecoveryCount, 'text', 'texts')} ` +
          `${plural(unansweredRecoveryCount, 'is', 'are')} still unanswered.`,
      );
    }

    const anyContent = sentences.length > 0;
    const summary = anyContent
      ? `You're waiting on: ${sentences.join(' ')}`
      : "You're not waiting on anything — no estimates out, no unpaid invoices.";

    const status = anyContent ? 'found' : 'none';
    await recordEvent(
      status,
      estimates.length + invoices.length + (unansweredRecoveryCount ?? 0),
      summary,
    );

    return {
      status,
      summary,
      data: {
        estimates,
        invoices,
        ...(unansweredRecoveryCount !== undefined ? { unansweredRecoveryCount } : {}),
      },
    };
  } catch (err) {
    const message = "I'm having trouble pulling up what you're waiting on right now.";
    await recordEvent('error', 0, message);
    return {
      status: 'error',
      summary: message,
      data: { error: err instanceof Error ? err.message : String(err) },
    };
  }
}
