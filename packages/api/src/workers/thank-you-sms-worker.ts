/**
 * Post-job thank-you SMS sweeper.
 *
 * Mirrors the P0-009 sweep pattern from `google-reviews.ts` /
 * `estimate-reminder-worker.ts`: a cross-tenant sweep with per-tenant
 * try/catch (one tenant's failure never crashes the loop) plus a
 * per-job try/catch (one bad recipient doesn't skip the rest of that
 * tenant's eligible jobs). For each tenant with
 * `tenant_settings.send_thank_you_sms = true`, the sweep finds jobs
 * that:
 *
 *   1. Have transitioned to 'completed' (completed_at IS NOT NULL),
 *   2. Are at least `delayHours` past completion (default 2),
 *   3. Have not already had thank-you SMS handled
 *      (thank_you_sms_sent_at IS NULL).
 *
 * For each, it renders `sms.thank_you.line1` from the per-tenant
 * `businessName`, dispatches one SMS via the injected dispatcher, and
 * sets `thank_you_sms_sent_at = NOW()` — the column write is the
 * idempotency gate; a re-run within the same sweep cadence is a no-op.
 * Suppressed-for-permanent-reason paths (customer has no SMS-capable
 * phone, DNC list, smsConsent=false) also set `thank_you_sms_sent_at`
 * with a `notification.thank_you_sms.suppressed` audit event so the
 * sweep doesn't re-evaluate the same row forever. Transient errors
 * (dispatcher throws) leave the stamp null so the next sweep retries.
 *
 * Sweep cadence is owned by app.ts (a setInterval driver). Tests
 * exercise this function directly with in-memory repos and a fixed
 * clock.
 *
 * Why not Inngest: the codebase intentionally uses db-backed durable
 * queues + cross-tenant sweeps (P0-009) instead of an external
 * scheduler. The Google Reviews 24hr poll and the
 * appointment-reminder/overdue-invoice/estimate-reminder workers all
 * use the same idiom; this matches.
 */
import { Pool } from 'pg';
import { Logger } from '../logging/logger';
import { Job, JobRepository } from '../jobs/job';
import { CustomerRepository } from '../customers/customer';
import { SettingsRepository } from '../settings/settings';
import { AuditRepository, createAuditEvent } from '../audit/audit';
import { DncRepository, normalizePhone } from '../compliance/dnc';
import { resolveCustomerLanguage } from '../i18n/resolve-language';
import { renderThankYouSms } from '../notifications/templates';
import { FeedbackDispatcher } from '../feedback/dispatcher';
import { SmsSuppressedError } from '../notifications/gated-message-delivery';

const HOUR_MS = 60 * 60 * 1000;
const THANK_YOU_ACTOR = 'system:thank_you_sms';

export interface ThankYouSmsWorkerDeps {
  /** Source of truth for eligibility queries (cross-table jobs + tenant_settings). */
  pool: Pool | null;
  jobRepo: JobRepository;
  customerRepo: CustomerRepository;
  settingsRepo: SettingsRepository;
  dncRepo: DncRepository;
  /**
   * SMS transport. Reuses the FeedbackDispatcher shape (single tenant
   * Twilio number in the current architecture) so we don't duplicate
   * the Twilio impl. Pass NoopFeedbackDispatcher in environments
   * without SMS credentials.
   */
  dispatcher: FeedbackDispatcher;
  auditRepo?: AuditRepository;
  logger: Logger;
  /** Injectable clock — defaults to `() => new Date()`. */
  now?: () => Date;
  /**
   * Delay between job.completed_at and the thank-you send. Default 2 hours
   * per PRD §7.2. Configurable so tests can fire the sweep against
   * recently-completed jobs without sleeping.
   */
  delayHours?: number;
}

export interface ThankYouSmsSweepResult {
  /** Tenants iterated (may include tenants with the toggle off, which return 0 candidates). */
  tenants: number;
  /** Jobs that crossed the eligibility threshold this sweep. */
  candidates: number;
  /** SMS successfully dispatched. */
  sent: number;
  /** Eligible jobs short-circuited (no phone, DNC, no consent, opted-out). */
  suppressed: number;
  /** Transient errors that left thank_you_sms_sent_at null for retry. */
  failed: number;
}

/**
 * Eligibility query — single SQL that joins jobs to tenant_settings so
 * a tenant toggle change takes effect immediately. The condition
 * mirrors the partial index from migration 194.
 */
const ELIGIBLE_SQL = `
  SELECT j.id, j.tenant_id
    FROM jobs j
    JOIN tenant_settings ts ON ts.tenant_id = j.tenant_id
   WHERE ts.send_thank_you_sms = TRUE
     AND j.completed_at IS NOT NULL
     AND j.thank_you_sms_sent_at IS NULL
     AND j.completed_at <= $1
   ORDER BY j.completed_at ASC
   LIMIT 500
`;

interface EligibleRow {
  id: string;
  tenant_id: string;
}

export async function runThankYouSmsSweep(
  deps: ThankYouSmsWorkerDeps,
): Promise<ThankYouSmsSweepResult> {
  const now = deps.now ?? (() => new Date());
  const delayHours = deps.delayHours ?? 2;
  const result: ThankYouSmsSweepResult = {
    tenants: 0,
    candidates: 0,
    sent: 0,
    suppressed: 0,
    failed: 0,
  };

  if (!deps.pool) {
    // Mirror the no-DB-no-op posture of google-reviews / overdue-invoice
    // sweeps — dev runs without a database just return zeros.
    return result;
  }

  const asOf = now();
  const completedBefore = new Date(asOf.getTime() - delayHours * HOUR_MS);

  let rows: EligibleRow[];
  try {
    const queryResult = await deps.pool.query<EligibleRow>(ELIGIBLE_SQL, [completedBefore]);
    rows = queryResult.rows;
  } catch (err) {
    deps.logger.error('Thank-you SMS sweep: eligibility query failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return result;
  }

  // Group by tenant so the per-tenant try/catch + the tenant-scoped
  // dispatcher resolution happens once per tenant rather than per-row.
  const byTenant = new Map<string, string[]>();
  for (const row of rows) {
    const list = byTenant.get(row.tenant_id) ?? [];
    list.push(row.id);
    byTenant.set(row.tenant_id, list);
  }
  result.tenants = byTenant.size;
  result.candidates = rows.length;

  for (const [tenantId, jobIds] of byTenant) {
    try {
      await sweepTenant(deps, tenantId, jobIds, result);
    } catch (err) {
      // One tenant's failure never stops the loop.
      result.failed += jobIds.length;
      deps.logger.warn('Thank-you SMS sweep: tenant failed', {
        tenantId,
        jobCount: jobIds.length,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}

async function sweepTenant(
  deps: ThankYouSmsWorkerDeps,
  tenantId: string,
  jobIds: string[],
  result: ThankYouSmsSweepResult,
): Promise<void> {
  const settings = await deps.settingsRepo.findByTenant(tenantId);
  // The query already gates on send_thank_you_sms = true, so a tenant
  // with the toggle off shouldn't appear. Defense-in-depth in case the
  // settings row was updated between the SELECT and now.
  if (settings && settings.sendThankYouSms === false) return;

  const businessName = settings?.businessName ?? 'our team';

  for (const jobId of jobIds) {
    try {
      const outcome = await sendOneThankYou(deps, tenantId, jobId, businessName);
      if (outcome === 'sent') result.sent++;
      else if (outcome === 'suppressed') result.suppressed++;
    } catch (err) {
      // Transient: leave thank_you_sms_sent_at null so the next sweep retries.
      result.failed++;
      deps.logger.warn('Thank-you SMS sweep: job send failed', {
        tenantId,
        jobId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

type SendOutcome = 'sent' | 'suppressed';

async function sendOneThankYou(
  deps: ThankYouSmsWorkerDeps,
  tenantId: string,
  jobId: string,
  businessName: string,
): Promise<SendOutcome> {
  const job = await deps.jobRepo.findById(tenantId, jobId);
  if (!job) {
    // Job vanished between SELECT and now — suppress so we don't loop.
    await markHandled(deps, tenantId, jobId, null, 'job_not_found');
    return 'suppressed';
  }

  const customer = await deps.customerRepo.findById(tenantId, job.customerId);

  // Permanent suppressions — stamp sent_at so the sweep doesn't re-evaluate.
  if (!customer?.primaryPhone) {
    await markHandled(deps, tenantId, jobId, customer?.id ?? null, 'no_phone');
    return 'suppressed';
  }
  if (customer.smsConsent !== true) {
    await markHandled(deps, tenantId, jobId, customer.id, 'no_sms_consent');
    return 'suppressed';
  }
  const normalizedTo = normalizePhone(customer.primaryPhone);
  if (await deps.dncRepo.isOnDnc(tenantId, normalizedTo)) {
    await markHandled(deps, tenantId, jobId, customer.id, 'on_dnc');
    return 'suppressed';
  }

  // Settings lookup is repeated here only to resolve language; the
  // outer caller already verified the toggle.
  const settings = await deps.settingsRepo.findByTenant(tenantId);
  const language = resolveCustomerLanguage({
    customerPreferredLanguage: customer.preferredLanguage,
    tenantDefaultLanguage: settings?.defaultLanguage,
  });
  const { body } = renderThankYouSms({ businessName, language });

  // Forward tenant scope + the customer's consent snapshot so the central
  // consent+DNC gate (GatedMessageDelivery) can allow the send. Omitting these
  // made every send fail closed as `missing_consent_context` under the prod
  // default 'block' mode — the send was counted transient and retried hot every
  // sweep, and thank_you_sms_sent_at was never stamped.
  try {
    await deps.dispatcher.send({
      to: customer.primaryPhone,
      body,
      tenantId,
      consent: { smsConsent: customer.smsConsent === true, customerId: customer.id },
    });
  } catch (err) {
    if (err instanceof SmsSuppressedError) {
      // Terminal: the gate suppressed (e.g. the number hit the DNC list between
      // our precheck above and the send). Stamp so the sweep stops re-evaluating
      // this row — mirrors the no_phone / no_consent / on_dnc terminal paths
      // rather than looping as a transient retry forever.
      await markHandled(deps, tenantId, jobId, customer.id, `gate_${err.reason}`);
      return 'suppressed';
    }
    throw err; // transient (e.g. Twilio 5xx) — leave the stamp null for retry.
  }

  await deps.jobRepo.update(tenantId, jobId, {
    thankYouSmsSentAt: (deps.now ?? (() => new Date()))(),
  });
  await emitAudit(deps, {
    tenantId,
    jobId,
    customerId: customer.id,
    outcome: 'sent',
  });
  return 'sent';
}

async function markHandled(
  deps: ThankYouSmsWorkerDeps,
  tenantId: string,
  jobId: string,
  customerId: string | null,
  reason: string,
): Promise<void> {
  await deps.jobRepo.update(tenantId, jobId, {
    thankYouSmsSentAt: (deps.now ?? (() => new Date()))(),
  });
  await emitAudit(deps, {
    tenantId,
    jobId,
    customerId,
    outcome: 'suppressed',
    reason,
  });
}

async function emitAudit(
  deps: ThankYouSmsWorkerDeps,
  input: {
    tenantId: string;
    jobId: string;
    customerId: string | null;
    outcome: SendOutcome;
    reason?: string;
  },
): Promise<void> {
  if (!deps.auditRepo) return;
  const event = createAuditEvent({
    tenantId: input.tenantId,
    actorId: THANK_YOU_ACTOR,
    actorRole: 'system',
    eventType:
      input.outcome === 'sent'
        ? 'notification.thank_you_sms.sent'
        : 'notification.thank_you_sms.suppressed',
    entityType: 'job',
    entityId: input.jobId,
    metadata: {
      customerId: input.customerId,
      ...(input.reason ? { reason: input.reason } : {}),
    },
  });
  await deps.auditRepo.create(event);
}

/** Exported solely so tests can assert against the same name. */
export { THANK_YOU_ACTOR };

/** Re-exported so the test file gets the same Job shape it asserts on. */
export type { Job };
