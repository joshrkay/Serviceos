/**
 * §6 Time-to-Cash — overdue-invoice sweeper.
 *
 * Mirrors the P0-009 execution-worker pattern: a cross-tenant sweep that
 * never lets one tenant's failure crash the loop, with per-tenant
 * try/catch and a `failed` counter for observability (the same shape as
 * `execution-worker.ts`; `recurring-agreements-worker.ts` uses a similar
 * structure but only logs on failure without counting).
 * For each tenant it finds unpaid invoices past their due date, refreshes
 * the linked job's money-state (which flips it to `overdue`), and emits an
 * `invoice.overdue` audit event the first time a job crosses into the
 * overdue state.
 *
 * §7 Collections cadence (P20). For every overdue invoice the sweep walks
 * the tenant's dunning cadence (invoices/dunning-schedule.ts) and late-fee
 * policy (invoices/late-fee.ts) and raises OWNER-APPROVED proposals — one
 * `send_payment_reminder` (comms) per due reminder step and an
 * `apply_late_fee` (money) when a fee is due. Nothing is sent or charged
 * here: the customer is contacted / the fee is applied only after the owner
 * approves the proposal (the execution worker then runs the handler). The
 * `invoice_dunning_events` ledger (UNIQUE on tenant+invoice+kind+step_key)
 * gates idempotency so a re-sweep never raises a duplicate proposal.
 *
 * The sweep cadence is owned by app.ts (a setInterval driver). Tests
 * exercise this function directly with in-memory repos and a fixed clock.
 */
import { v4 as uuidv4 } from 'uuid';
import { formatUsdCents } from '@ai-service-os/shared';
import { Logger } from '../logging/logger';
import { JobRepository } from '../jobs/job';
import { EstimateRepository } from '../estimates/estimate';
import { Invoice, InvoiceRepository } from '../invoices/invoice';
import { CustomerRepository } from '../customers/customer';
import { AuditRepository, createAuditEvent } from '../audit/audit';
import { notifyOwner } from '../notifications/owner-notifications-instance';
import { refreshJobMoneyStateSafe } from '../jobs/job-money-state';
import { ProposalRepository, createProposal } from '../proposals/proposal';
import {
  DunningConfig,
  DunningConfigRepository,
  DunningEventRepository,
  defaultDunningConfig,
  LATE_FEE_ONE_TIME_KEY,
} from '../invoices/dunning-config';
import { selectDueReminderSteps } from '../invoices/dunning-schedule';
import { computeLateFeeCents } from '../invoices/late-fee';

/** Synthetic actor for sweep-raised collections proposals (no Clerk session). */
const DUNNING_ACTOR_ID = 'overdue-invoice-worker';

export interface OverdueInvoiceWorkerDeps {
  jobRepo: JobRepository;
  estimateRepo: EstimateRepository;
  invoiceRepo: InvoiceRepository;
  auditRepo: AuditRepository;
  /** Returns the list of tenant IDs to sweep. */
  listTenantIds: () => Promise<string[]>;
  logger: Logger;
  /** Injectable clock — defaults to `() => new Date()`. */
  now?: () => Date;
  /**
   * §7 Collections cadence. When `proposalRepo` and `dunningEventRepo` are
   * both wired, each overdue invoice's due reminder steps + late fees surface
   * as owner-approved proposals (gated for idempotency by the dunning event
   * ledger). Absent → the sweep does money-state + overdue-audit work only
   * (no dunning), preserving the pre-cadence behavior for callers that don't
   * opt in. `dunningConfigRepo` is optional even when dunning is enabled:
   * absent (or no row) → the conservative `defaultDunningConfig` (single
   * 3-day SMS reminder, no late fee).
   */
  proposalRepo?: ProposalRepository;
  dunningEventRepo?: DunningEventRepository;
  dunningConfigRepo?: DunningConfigRepository;
  /**
   * U6 owner `invoice_overdue` push. When wired, the owner's devices get a
   * best-effort push the first time a job crosses INTO `overdue` (the same
   * transition tick that emits the `invoice.overdue` audit — so the existing
   * money-state transition guard is the idempotency anchor: a re-sweep reports
   * `changed:false` and never re-pushes). Used to resolve the customer name;
   * omit → no owner push (the sweep is otherwise unchanged).
   */
  customerRepo?: CustomerRepository;
}

/** Owner-facing display name (mirrors the transactional-comms customer label). */
function overdueCustomerName(customer: {
  firstName?: string;
  lastName?: string;
  displayName?: string;
}): string {
  return (
    customer.displayName ||
    [customer.firstName, customer.lastName].filter(Boolean).join(' ') ||
    'A customer'
  );
}

/**
 * Fire the owner `invoice_overdue` push for one invoice (best-effort).
 * amountLabel is formatted from INTEGER CENTS via the shared money formatter.
 * Never throws — the push must never disturb the sweep. Gated by the caller at
 * the transition-into-overdue tick, so it inherits that dispatch idempotency.
 * Exported for focused unit testing.
 */
export async function notifyOwnerInvoiceOverdue(
  tenantId: string,
  invoice: Invoice,
  deps: OverdueInvoiceWorkerDeps,
): Promise<void> {
  const { jobRepo, customerRepo } = deps;
  if (!customerRepo) return;
  try {
    const job = await jobRepo.findById(tenantId, invoice.jobId);
    if (!job) return;
    const customer = await customerRepo.findById(tenantId, job.customerId);
    if (!customer) return;
    await notifyOwner(tenantId, 'invoice_overdue', {
      invoiceId: invoice.id,
      customerName: overdueCustomerName(customer),
      amountLabel: formatUsdCents(invoice.amountDueCents),
    });
  } catch (err) {
    deps.logger.warn('Overdue-invoice sweep: owner push failed', {
      tenantId,
      invoiceId: invoice.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function runOverdueInvoiceSweep(
  deps: OverdueInvoiceWorkerDeps,
): Promise<{ tenants: number; overdue: number; failed: number }> {
  const now = deps.now ?? (() => new Date());

  let tenantIds: string[];
  try {
    tenantIds = await deps.listTenantIds();
  } catch (err) {
    deps.logger.error('Overdue-invoice sweep: failed to list tenants', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { tenants: 0, overdue: 0, failed: 0 };
  }

  const asOf = now(); // One snapshot for the entire sweep.
  // Dunning runs only when we can both create proposals and gate them
  // idempotently. Either dep missing → money-state-only sweep.
  const dunningEnabled = Boolean(deps.proposalRepo && deps.dunningEventRepo);
  let overdue = 0;
  let failed = 0;

  for (const tenantId of tenantIds) {
    try {
      // Load the tenant's dunning cadence once per sweep. Fall back to the
      // conservative default so dunning is never silently off for an overdue
      // invoice (matches defaultDunningConfig's contract).
      const config: DunningConfig | null = dunningEnabled
        ? ((deps.dunningConfigRepo
            ? await deps.dunningConfigRepo.findByTenant(tenantId)
            : null) ?? defaultDunningConfig(tenantId, asOf))
        : null;

      // Prefilter: unpaid invoices whose due date has passed. The
      // authoritative overdue decision is made by computeJobMoneyState
      // inside refreshJobMoneyState — this query just narrows the set.
      const candidates = [
        ...(await deps.invoiceRepo.findByTenant(tenantId, {
          status: 'open',
          toDueDate: asOf,
        })),
        ...(await deps.invoiceRepo.findByTenant(tenantId, {
          status: 'partially_paid',
          toDueDate: asOf,
        })),
      ];

      for (const invoice of candidates) {
        const result = await refreshJobMoneyStateSafe(
          tenantId,
          invoice.jobId,
          'overdue-invoice-worker',
          {
            jobRepo: deps.jobRepo,
            estimateRepo: deps.estimateRepo,
            invoiceRepo: deps.invoiceRepo,
            auditRepo: deps.auditRepo,
            now: deps.now,
          },
          deps.logger,
        );

        // Emit invoice.overdue only on the transition INTO overdue, so a
        // re-run of the sweep doesn't re-fire the event: once the job is
        // `overdue`, refreshJobMoneyState reports changed:false.
        if (result.changed && result.current === 'overdue') {
          overdue++;
          await deps.auditRepo.create(
            createAuditEvent({
              tenantId,
              actorId: 'overdue-invoice-worker',
              actorRole: 'system',
              eventType: 'invoice.overdue',
              entityType: 'invoice',
              entityId: invoice.id,
              metadata: {
                jobId: invoice.jobId,
                dueDate: invoice.dueDate?.toISOString(),
                amountDueCents: invoice.amountDueCents,
              },
            }),
          );
          // U6 — owner push on the transition INTO overdue. Idempotent by the
          // same guard as the audit above (a re-sweep reports changed:false).
          await notifyOwnerInvoiceOverdue(tenantId, invoice, deps);
        }

        // §7 Collections cadence — raise owner-approved dunning proposals for
        // every still-overdue invoice (not just the transition tick: reminder
        // steps come due over time). Isolated per-invoice so one bad invoice
        // never aborts the rest of the tenant's sweep.
        if (config && invoice.dueDate) {
          try {
            await raiseDunningProposals(tenantId, invoice, config, asOf, deps);
          } catch (err) {
            deps.logger.warn('Overdue-invoice sweep: dunning failed for invoice', {
              tenantId,
              invoiceId: invoice.id,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }
    } catch (err) {
      // Mirror execution-worker.ts: one tenant's failure is logged and
      // swallowed so the sweep keeps going.
      failed++;
      deps.logger.warn('Overdue-invoice sweep: tenant failed', {
        tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  deps.logger.info('Overdue-invoice sweep completed', {
    tenants: tenantIds.length,
    overdue,
    failed,
  });

  return { tenants: tenantIds.length, overdue, failed };
}

/**
 * Raise the dunning proposals due for one overdue invoice: a
 * `send_payment_reminder` (comms) per due cadence step, plus an
 * `apply_late_fee` (money) when the policy makes a fee due. The dunning
 * event ledger is the idempotency gate — we record the event FIRST and treat
 * a 23505 unique violation as "a prior sweep already raised this", so at most
 * one proposal is ever created per (invoice, kind, step). Proposals are
 * surfaced in `ready_for_review` so the owner approves them (queue / digest /
 * SMS); execution (the actual send / fee application) happens on approval.
 *
 * Requires `proposalRepo` + `dunningEventRepo` (guaranteed by the
 * `dunningEnabled` gate at the call site).
 */
async function raiseDunningProposals(
  tenantId: string,
  invoice: Invoice,
  config: DunningConfig,
  now: Date,
  deps: OverdueInvoiceWorkerDeps,
): Promise<void> {
  const proposalRepo = deps.proposalRepo!;
  const eventRepo = deps.dunningEventRepo!;
  const dueDate = invoice.dueDate!;

  const priorEvents = await eventRepo.findByInvoice(tenantId, invoice.id);
  const sentStepKeys = priorEvents
    .filter((e) => e.kind === 'reminder')
    .map((e) => e.stepKey);
  const alreadyAccruedCents = priorEvents
    .filter((e) => e.kind === 'late_fee')
    .reduce((sum, e) => sum + (e.amountCents ?? 0), 0);

  // 1. Reminder cadence — one comms proposal per newly-due step.
  const dueSteps = selectDueReminderSteps(config, { dueDate, now, sentStepKeys });
  for (const { stepKey, step } of dueSteps) {
    // Ledger gate: record the step BEFORE creating the proposal so a
    // concurrent/re-run sweep that loses the UNIQUE race (23505) skips it.
    if (
      !(await recordDunningEvent(eventRepo, {
        id: uuidv4(),
        tenantId,
        invoiceId: invoice.id,
        kind: 'reminder',
        stepKey,
        channel: step.channel,
        sentAt: now,
      }))
    ) {
      continue;
    }

    const proposal = createProposal({
      tenantId,
      proposalType: 'send_payment_reminder',
      payload: {
        invoiceId: invoice.id,
        stepKey,
        offsetDays: step.offsetDays,
        channel: step.channel,
      },
      summary: `Send overdue-payment reminder for ${invoice.invoiceNumber} (${step.offsetDays}d past due)`,
      createdBy: DUNNING_ACTOR_ID,
    });
    await proposalRepo.create({ ...proposal, status: 'ready_for_review' });
    await safeAudit(deps, tenantId, invoice.id, {
      proposalId: proposal.id,
      proposalType: 'send_payment_reminder',
      stepKey,
    });
  }

  // 2. Late fee — one money proposal when a fee is due (one-time policy).
  const feeCents = computeLateFeeCents(config, {
    amountDueCents: invoice.amountDueCents,
    dueDate,
    now,
    alreadyAccruedCents,
  });
  if (feeCents > 0) {
    if (
      await recordDunningEvent(eventRepo, {
        id: uuidv4(),
        tenantId,
        invoiceId: invoice.id,
        kind: 'late_fee',
        stepKey: LATE_FEE_ONE_TIME_KEY,
        amountCents: feeCents,
        sentAt: now,
      })
    ) {
      const proposal = createProposal({
        tenantId,
        proposalType: 'apply_late_fee',
        payload: {
          invoiceId: invoice.id,
          feeCents,
          stepKey: LATE_FEE_ONE_TIME_KEY,
        },
        summary: `Apply late fee to ${invoice.invoiceNumber}`,
        createdBy: DUNNING_ACTOR_ID,
      });
      await proposalRepo.create({ ...proposal, status: 'ready_for_review' });
      await safeAudit(deps, tenantId, invoice.id, {
        proposalId: proposal.id,
        proposalType: 'apply_late_fee',
        stepKey: LATE_FEE_ONE_TIME_KEY,
        feeCents,
      });
    }
  }
}

/**
 * Insert a dunning ledger row. Returns `true` when this sweep won the row,
 * `false` when a prior sweep already recorded it (PG unique_violation 23505 —
 * the in-memory repo mirrors the code). Any other error propagates.
 */
async function recordDunningEvent(
  eventRepo: DunningEventRepository,
  event: Parameters<DunningEventRepository['create']>[0],
): Promise<boolean> {
  try {
    await eventRepo.create(event);
    return true;
  } catch (err) {
    if ((err as { code?: string }).code === '23505') return false;
    throw err;
  }
}

/** Failure-soft audit of a raised dunning proposal — never aborts the sweep. */
async function safeAudit(
  deps: OverdueInvoiceWorkerDeps,
  tenantId: string,
  invoiceId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  try {
    await deps.auditRepo.create(
      createAuditEvent({
        tenantId,
        actorId: DUNNING_ACTOR_ID,
        actorRole: 'system',
        eventType: 'invoice.dunning_proposed',
        entityType: 'invoice',
        entityId: invoiceId,
        metadata,
      }),
    );
  } catch {
    // swallow — audit must never fail the sweep
  }
}
