/**
 * P9-003 — Service agreement orchestration.
 *
 * IMPORTANT: Service agreements bypass the proposals layer because they are
 * pre-approved at creation time; subsequent runs execute that approval.
 * The owner who signs the customer up for "Quarterly HVAC Tune-up" is
 * giving standing consent for each cycle's job + draft invoice. We still
 * emit audit events so the same observability story holds, but we do not
 * round-trip every cycle through proposals/approvals.
 *
 * Idempotency model:
 *   - Each (agreement_id, scheduled_for) pair maps to at most one run.
 *   - The DB UNIQUE constraint is the safety net; the service performs a
 *     pre-check to avoid burning job/invoice numbers on duplicate calls.
 *   - Concurrent runners that lose the race see a unique_violation
 *     (Postgres SQLSTATE 23505) and treat it as a no-op skip.
 */
import { v4 as uuidv4 } from 'uuid';
import { ValidationError } from '../shared/errors';
import { AuditRepository, createAuditEvent } from '../audit/audit';
import {
  Agreement,
  AgreementRepository,
} from './agreement';
import {
  AgreementRun,
  AgreementRunRepository,
} from './agreement-run';
import {
  AgreementStatus,
  RecurrenceFrequency,
  RUN_STATUSES,
} from './enums';
import { daysInMonth, nextOccurrence, parseRule } from './recurrence';

void RUN_STATUSES;
void ({} as RecurrenceFrequency);

export interface CreateAgreementInput {
  tenantId: string;
  customerId: string;
  locationId?: string;
  name: string;
  description?: string;
  recurrenceRule: string;
  priceCents: number;
  autoGenerateInvoice?: boolean;
  autoGenerateJob?: boolean;
  startsOn: string;
  endsOn?: string;
  /** Membership auto-renew. Requires endsOn + renewalTermMonths (see validation). */
  autoRenew?: boolean;
  renewalTermMonths?: number;
  createdBy: string;
  actorRole?: string;
}

export interface UpdateAgreementInput {
  name?: string;
  description?: string;
  recurrenceRule?: string;
  priceCents?: number;
  autoGenerateInvoice?: boolean;
  autoGenerateJob?: boolean;
  endsOn?: string | null;
  autoRenew?: boolean;
  renewalTermMonths?: number | null;
}

/**
 * Minimal port for the jobs subsystem so tests can mock without dragging
 * the full domain in. The real prod implementation calls
 * `createJob(input, jobRepo, auditRepo)`.
 */
export interface JobsServicePort {
  createJob(input: {
    tenantId: string;
    customerId: string;
    locationId: string;
    summary: string;
    createdBy: string;
  }): Promise<{ id: string }>;
}

/**
 * Minimal port for the invoices subsystem.
 */
export interface InvoicesServicePort {
  createDraftInvoice(input: {
    tenantId: string;
    jobId: string;
    priceCents: number;
    description: string;
    createdBy: string;
  }): Promise<{ id: string }>;
}

export interface RunDueResult {
  generatedRunIds: string[];
  skippedRunIds: string[];
  failedRunIds: string[];
}

function startOfTodayUTC(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function parseDateOnly(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/**
 * Compute the first scheduled run from a startsOn date + rule.
 * If startsOn matches the rule's BYMONTHDAY, that IS the first run.
 */
function computeFirstRun(rule: string, startsOn: string): Date {
  const parsed = parseRule(rule);
  const start = parseDateOnly(startsOn);
  // If startsOn already satisfies the rule, return startsOn itself.
  if (parsed.byMonthDay === undefined || start.getUTCDate() === Math.min(
    parsed.byMonthDay,
    new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)).getUTCDate(),
  )) {
    return start;
  }
  // Otherwise, compute next occurrence strictly after the day before start.
  const beforeStart = new Date(start.getTime() - 86_400_000);
  return nextOccurrence(parsed, beforeStart);
}

/**
 * Add `months` whole months to a YYYY-MM-DD calendar date, clamping the day to
 * the target month's length (Jan 31 + 1mo → Feb 28/29). UTC throughout — these
 * are dates, not instants.
 */
function addMonthsToDateString(ymd: string, months: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  // m is 1-indexed in the string; Date months are 0-indexed.
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const ty = target.getUTCFullYear();
  const tm = target.getUTCMonth(); // 0-indexed
  const day = Math.min(d, daysInMonth(ty, tm + 1));
  return new Date(Date.UTC(ty, tm, day)).toISOString().slice(0, 10);
}

/**
 * Membership invariant: auto-renew needs a fixed term to renew (`endsOn`) and a
 * positive term length (`renewalTermMonths`). `term === null` means "being
 * cleared" on update and is rejected when auto-renew stays on.
 */
function assertAutoRenewInvariant(
  autoRenew: boolean,
  endsOn: string | undefined,
  term: number | null | undefined,
): void {
  if (!autoRenew) return;
  if (!endsOn) {
    throw new ValidationError('auto-renew requires endsOn (a fixed term to renew)');
  }
  if (term === null || term === undefined || !Number.isInteger(term) || term < 1) {
    throw new ValidationError('auto-renew requires renewalTermMonths >= 1');
  }
}

export async function createAgreement(
  input: CreateAgreementInput,
  agreementRepo: AgreementRepository,
  auditRepo?: AuditRepository,
): Promise<Agreement> {
  if (!input.tenantId) throw new ValidationError('tenantId is required');
  if (!input.customerId) throw new ValidationError('customerId is required');
  if (!input.name) throw new ValidationError('name is required');
  if (!input.recurrenceRule) throw new ValidationError('recurrenceRule is required');
  if (!input.startsOn) throw new ValidationError('startsOn is required');
  if (!Number.isInteger(input.priceCents) || input.priceCents < 0) {
    throw new ValidationError('priceCents must be a non-negative integer');
  }
  if (input.endsOn && input.endsOn < input.startsOn) {
    throw new ValidationError('endsOn must not be before startsOn');
  }
  assertAutoRenewInvariant(input.autoRenew ?? false, input.endsOn, input.renewalTermMonths);
  // Validate the rule by parsing it; throws RecurrenceRuleError on bad input.
  parseRule(input.recurrenceRule);

  const now = new Date();
  const firstRun = computeFirstRun(input.recurrenceRule, input.startsOn);

  const agreement: Agreement = {
    id: uuidv4(),
    tenantId: input.tenantId,
    customerId: input.customerId,
    locationId: input.locationId,
    name: input.name,
    description: input.description,
    recurrenceRule: input.recurrenceRule,
    priceCents: input.priceCents,
    autoGenerateInvoice: input.autoGenerateInvoice ?? true,
    autoGenerateJob: input.autoGenerateJob ?? true,
    nextRunAt: firstRun,
    status: 'active',
    startsOn: input.startsOn,
    endsOn: input.endsOn,
    autoRenew: input.autoRenew ?? false,
    renewalTermMonths: input.autoRenew ? input.renewalTermMonths : undefined,
    renewalCount: 0,
    createdBy: input.createdBy,
    createdAt: now,
    updatedAt: now,
  };

  const created = await agreementRepo.create(agreement);

  if (auditRepo) {
    await auditRepo.create(
      createAuditEvent({
        tenantId: input.tenantId,
        actorId: input.createdBy,
        actorRole: input.actorRole ?? 'owner',
        eventType: 'service_agreement.created',
        entityType: 'service_agreement',
        entityId: created.id,
      }),
    );
  }
  return created;
}

export async function updateAgreement(
  tenantId: string,
  id: string,
  input: UpdateAgreementInput,
  agreementRepo: AgreementRepository,
): Promise<Agreement | null> {
  const existing = await agreementRepo.findById(tenantId, id);
  if (!existing) return null;
  if (existing.status === 'cancelled') {
    throw new ValidationError('Cannot edit a cancelled agreement');
  }
  if (input.recurrenceRule) parseRule(input.recurrenceRule);
  if (input.priceCents !== undefined && (!Number.isInteger(input.priceCents) || input.priceCents < 0)) {
    throw new ValidationError('priceCents must be a non-negative integer');
  }

  // Enforce the auto-renew invariant against the POST-update shape: any of the
  // three fields may come from this patch or persist from the existing row, so
  // a patch that toggles auto-renew on (or clears endsOn/term) is validated
  // against the others' effective values.
  const effectiveAutoRenew = input.autoRenew ?? existing.autoRenew ?? false;
  const effectiveEndsOn =
    input.endsOn !== undefined ? input.endsOn ?? undefined : existing.endsOn;
  const effectiveTerm =
    input.renewalTermMonths !== undefined ? input.renewalTermMonths : existing.renewalTermMonths;
  assertAutoRenewInvariant(effectiveAutoRenew, effectiveEndsOn, effectiveTerm);

  const updates: Partial<Agreement> = { updatedAt: new Date() };
  if (input.name !== undefined) updates.name = input.name;
  if (input.description !== undefined) updates.description = input.description;
  if (input.recurrenceRule !== undefined) updates.recurrenceRule = input.recurrenceRule;
  if (input.priceCents !== undefined) updates.priceCents = input.priceCents;
  if (input.autoGenerateInvoice !== undefined) updates.autoGenerateInvoice = input.autoGenerateInvoice;
  if (input.autoGenerateJob !== undefined) updates.autoGenerateJob = input.autoGenerateJob;
  if (input.endsOn !== undefined) updates.endsOn = input.endsOn ?? undefined;
  if (input.autoRenew !== undefined) updates.autoRenew = input.autoRenew;
  if (input.renewalTermMonths !== undefined) {
    updates.renewalTermMonths = input.renewalTermMonths ?? undefined;
  }

  return agreementRepo.update(tenantId, id, updates);
}

async function transitionStatus(
  tenantId: string,
  id: string,
  newStatus: AgreementStatus,
  agreementRepo: AgreementRepository,
): Promise<Agreement | null> {
  const existing = await agreementRepo.findById(tenantId, id);
  if (!existing) return null;
  if (existing.status === newStatus) return existing;
  if (existing.status === 'cancelled') {
    throw new ValidationError('Cannot change status of a cancelled agreement');
  }
  return agreementRepo.update(tenantId, id, { status: newStatus, updatedAt: new Date() });
}

export function pauseAgreement(
  tenantId: string,
  id: string,
  agreementRepo: AgreementRepository,
): Promise<Agreement | null> {
  return transitionStatus(tenantId, id, 'paused', agreementRepo);
}

export function resumeAgreement(
  tenantId: string,
  id: string,
  agreementRepo: AgreementRepository,
): Promise<Agreement | null> {
  return transitionStatus(tenantId, id, 'active', agreementRepo);
}

export function cancelAgreement(
  tenantId: string,
  id: string,
  agreementRepo: AgreementRepository,
): Promise<Agreement | null> {
  return transitionStatus(tenantId, id, 'cancelled', agreementRepo);
}

export interface RunDueDeps {
  agreementRepo: AgreementRepository;
  runRepo: AgreementRunRepository;
  jobsService: JobsServicePort;
  invoicesService: InvoicesServicePort;
  auditRepo?: AuditRepository;
  now?: Date;
}

/**
 * Sweep all active agreements whose next_run_at <= now.
 *
 * For each:
 *   1. Idempotency pre-check: if a run row already exists for
 *      (agreement_id, scheduled_for), skip and advance the next-run pointer.
 *   2. Generate job + draft invoice (subject to the agreement's flags).
 *   3. Insert the run row (DB UNIQUE constraint is the final guard).
 *   4. Advance agreement.next_run_at; mark `last_run_at = now`.
 *
 * Failures within a single agreement do NOT stall the sweep — we record a
 * 'failed' run row, log, and move on to the next agreement.
 */
export async function runDueAgreements(
  tenantId: string,
  deps: RunDueDeps,
): Promise<RunDueResult> {
  const now = deps.now ?? new Date();
  const generatedRunIds: string[] = [];
  const skippedRunIds: string[] = [];
  const failedRunIds: string[] = [];

  const due = await deps.agreementRepo.findDue(tenantId, now);
  for (const agreement of due) {
    const scheduledFor = startOfTodayUTC(agreement.nextRunAt);

    // Idempotency pre-check.
    const existing = await deps.runRepo.findByAgreementAndDate(
      tenantId,
      agreement.id,
      scheduledFor,
    );
    if (existing) {
      skippedRunIds.push(existing.id);
      // Still advance the agreement's pointer if it hasn't been advanced
      // (the prior generation may have crashed mid-update).
      const advanced = nextOccurrence(agreement.recurrenceRule, agreement.nextRunAt);
      if (advanced.getTime() > agreement.nextRunAt.getTime()) {
        await deps.agreementRepo.update(tenantId, agreement.id, {
          nextRunAt: advanced,
          updatedAt: new Date(),
        });
      }
      continue;
    }

    let jobId: string | undefined;
    let invoiceId: string | undefined;
    let runStatus: AgreementRun['status'] = 'generated';
    let errorMessage: string | undefined;

    try {
      if (agreement.autoGenerateJob) {
        const job = await deps.jobsService.createJob({
          tenantId,
          customerId: agreement.customerId,
          locationId: agreement.locationId ?? '',
          summary: agreement.name,
          createdBy: agreement.createdBy,
        });
        jobId = job.id;
      }
      if (agreement.autoGenerateInvoice) {
        const invoice = await deps.invoicesService.createDraftInvoice({
          tenantId,
          jobId: jobId ?? '',
          priceCents: agreement.priceCents,
          description: agreement.name,
          createdBy: agreement.createdBy,
        });
        invoiceId = invoice.id;
      }
    } catch (err) {
      runStatus = 'failed';
      errorMessage = err instanceof Error ? err.message : String(err);
    }

    const run: AgreementRun = {
      id: uuidv4(),
      tenantId,
      agreementId: agreement.id,
      scheduledFor,
      generatedJobId: jobId,
      generatedInvoiceId: invoiceId,
      status: runStatus,
      errorMessage,
      createdAt: new Date(),
    };

    let saved: AgreementRun;
    try {
      saved = await deps.runRepo.create(run);
    } catch (err) {
      // Lost the race to another worker — the row already exists, skip cleanly.
      const code = (err as { code?: string }).code;
      if (code === '23505') {
        const existingDup = await deps.runRepo.findByAgreementAndDate(
          tenantId,
          agreement.id,
          scheduledFor,
        );
        if (existingDup) skippedRunIds.push(existingDup.id);
        continue;
      }
      throw err;
    }

    if (runStatus === 'failed') {
      failedRunIds.push(saved.id);
    } else {
      generatedRunIds.push(saved.id);
    }

    // Advance the agreement pointer.
    const advanced = nextOccurrence(agreement.recurrenceRule, agreement.nextRunAt);
    await deps.agreementRepo.update(tenantId, agreement.id, {
      nextRunAt: advanced,
      lastRunAt: now,
      updatedAt: new Date(),
    });

    if (deps.auditRepo) {
      await deps.auditRepo.create(
        createAuditEvent({
          tenantId,
          actorId: 'system:agreements-worker',
          actorRole: 'system',
          eventType: `service_agreement.run.${runStatus}`,
          entityType: 'service_agreement',
          entityId: agreement.id,
          metadata: { runId: saved.id, scheduledFor, jobId, invoiceId },
        }),
      );
    }
  }

  return { generatedRunIds, skippedRunIds, failedRunIds };
}

export interface RenewDueDeps {
  agreementRepo: AgreementRepository;
  auditRepo?: AuditRepository;
  now?: Date;
}

export interface RenewDueResult {
  renewedAgreementIds: string[];
}

/**
 * Roll forward the term of every active, auto-renew agreement whose `ends_on`
 * has lapsed. The new `ends_on` advances by `renewalTermMonths` until it is
 * strictly in the future, so a worker that was down for several terms catches
 * up in one pass instead of leaving a membership lapsed. `renewal_count` is
 * bumped by the number of terms added and a `service_agreement.renewed` audit
 * event records the transition.
 *
 * Runs BEFORE runDueAgreements in the sweep so a just-renewed agreement whose
 * next run is already due fires this cycle rather than waiting another sweep.
 */
export async function renewExpiringAgreements(
  tenantId: string,
  deps: RenewDueDeps,
): Promise<RenewDueResult> {
  const now = deps.now ?? new Date();
  const today = now.toISOString().slice(0, 10);
  const renewedAgreementIds: string[] = [];

  const renewable = await deps.agreementRepo.findRenewable(tenantId, now);
  for (const agreement of renewable) {
    // findRenewable guarantees both are set; narrow for the type checker.
    if (!agreement.endsOn || !agreement.renewalTermMonths) continue;

    let newEndsOn = agreement.endsOn;
    let termsAdded = 0;
    // Cap the catch-up loop; 600 months = 50 years of missed renewals.
    while (newEndsOn <= today && termsAdded < 600) {
      newEndsOn = addMonthsToDateString(newEndsOn, agreement.renewalTermMonths);
      termsAdded++;
    }
    if (termsAdded === 0) continue;

    const newRenewalCount = (agreement.renewalCount ?? 0) + termsAdded;
    await deps.agreementRepo.update(tenantId, agreement.id, {
      endsOn: newEndsOn,
      renewalCount: newRenewalCount,
      updatedAt: new Date(),
    });
    renewedAgreementIds.push(agreement.id);

    if (deps.auditRepo) {
      await deps.auditRepo.create(
        createAuditEvent({
          tenantId,
          actorId: 'system:agreements-worker',
          actorRole: 'system',
          eventType: 'service_agreement.renewed',
          entityType: 'service_agreement',
          entityId: agreement.id,
          metadata: {
            previousEndsOn: agreement.endsOn,
            newEndsOn,
            termsAdded,
            renewalCount: newRenewalCount,
          },
        }),
      );
    }
  }

  return { renewedAgreementIds };
}
