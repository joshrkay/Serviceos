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
 *   2. Are at least `delayHours` past completion (default 2) and at most
 *      THANK_YOU_MAX_LATENESS_HOURS past that (the recency floor),
 *   3. Have not already had thank-you SMS handled
 *      (thank_you_sms_sent_at IS NULL).
 *
 * For each, it renders `sms.thank_you.line1` from the per-tenant
 * `businessName`, sends it through outbound messaging (D-045) as an
 * automated nudge, and sets `thank_you_sms_sent_at = NOW()` — the column
 * write is the idempotency gate; a re-run within the same sweep cadence is
 * a no-op. A send blocked for a permanent reason (no customer or phone,
 * DNC list, no SMS consent, a standing revocation) also sets
 * `thank_you_sms_sent_at` with a `notification.thank_you_sms.suppressed`
 * audit event so the sweep doesn't re-evaluate the same row forever. A
 * retryable block (kill switch, volume cap, provider error) leaves the
 * stamp null so the next sweep retries. Outside the recipient-local window
 * the send comes back scheduled, and the job likewise stays unstamped
 * (counted `deferred`) until an in-window sweep sends it.
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
import type { GatedMessageDelivery } from '../notifications/gated-message-delivery';
import type {
  MessageBlockReason,
  OutboundMessaging,
} from '../notifications/outbound-messaging';

/**
 * The suppression reason each permanent block is audited under. The local
 * pre-checks this worker used to run wrote `no_phone` / `no_sms_consent` /
 * `on_dnc`; a verdict only the gate could reach (a cross-channel revocation)
 * keeps its `consent_gate:` prefix. Kept so the audit trail reads the same
 * across the move to outbound messaging.
 */
const SUPPRESSION_AUDIT_REASON: Partial<Record<MessageBlockReason, string>> = {
  customer_not_found: 'no_phone',
  no_phone: 'no_phone',
  no_consent: 'no_sms_consent',
  dnc: 'on_dnc',
};
import { resolveCustomerLanguage } from '../i18n/resolve-language';
import { renderThankYouSms } from '../notifications/templates';
import { withSendClaim, readSendClaimStatus } from '../notifications/send-claim-ledger';

const HOUR_MS = 60 * 60 * 1000;

/**
 * Recency floor: a thank-you more than this many hours past its intended send
 * time (completed_at + delayHours) is never sent — after a toggle is switched
 * back on, or a sweep outage, "thanks for today" days later is a stale
 * solicitation, not a courtesy. Such jobs fall outside the eligibility query,
 * exactly like a toggled-off tenant's: never selected, so never stamped and
 * never re-evaluated.
 *
 * 24 h is far above the longest quiet-hours hold, so a deferred thank-you is
 * never aged out: ≤ 12 h for a known zone (20:00 → 08:00), ≈ 18 h for a
 * tenant with no zone (an Eastern 14:00–20:00 window).
 */
export const THANK_YOU_MAX_LATENESS_HOURS = 24;

const THANK_YOU_ACTOR = 'system:thank_you_sms';
const THANK_YOU_SENT_EVENT = 'notification.thank_you_sms.sent';

export interface ThankYouSmsWorkerDeps {
  /** Source of truth for eligibility queries (cross-table jobs + tenant_settings). */
  pool: Pool | null;
  jobRepo: JobRepository;
  customerRepo: CustomerRepository;
  settingsRepo: SettingsRepository;
  /**
   * Outbound messaging (D-045). Null when no SMS provider is wired: the sweep
   * then does nothing rather than stamping jobs whose text never went out.
   */
  messaging: OutboundMessaging | null;
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
  /**
   * The gate's send-window verdict. A tenant whose window is closed (its
   * zone, strictest close) has its jobs counted `deferred` with no per-job
   * work — they stay unstamped for an in-window tick. Absent → no check
   * (the gate still defers each send).
   */
  sendWindow?: Pick<GatedMessageDelivery, 'sendWindowVerdict'>;
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
  /**
   * Held back by the recipient's quiet hours: not sent, not stamped, claim
   * released — a later in-window sweep sends it.
   */
  deferred: number;
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
     AND j.completed_at >= $2
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
    deferred: 0,
  };

  if (!deps.pool || !deps.messaging) {
    // Mirror the no-DB-no-op posture of google-reviews / overdue-invoice
    // sweeps — dev runs without a database or an SMS provider return zeros.
    return result;
  }

  const pool = deps.pool; // narrowed non-null for the rest of this sweep
  const messaging = deps.messaging;
  const asOf = now();
  const completedBefore = new Date(asOf.getTime() - delayHours * HOUR_MS);
  const completedAfter = new Date(
    completedBefore.getTime() - THANK_YOU_MAX_LATENESS_HOURS * HOUR_MS,
  );

  let rows: EligibleRow[];
  try {
    const queryResult = await pool.query<EligibleRow>(ELIGIBLE_SQL, [completedBefore, completedAfter]);
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
      await sweepTenant(deps, pool, messaging, tenantId, jobIds, result);
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
  pool: Pool,
  messaging: OutboundMessaging,
  tenantId: string,
  jobIds: string[],
  result: ThankYouSmsSweepResult,
): Promise<void> {
  const settings = await deps.settingsRepo.findByTenant(tenantId);
  // The query already gates on send_thank_you_sms = true, so a tenant
  // with the toggle off shouldn't appear. Defense-in-depth in case the
  // settings row was updated between the SELECT and now.
  if (settings && settings.sendThankYouSms === false) return;

  if (deps.sendWindow && !(await deps.sendWindow.sendWindowVerdict({ tenantId })).isAllowedNow) {
    result.deferred += jobIds.length;
    return;
  }

  const businessName = settings?.businessName ?? 'our team';

  for (const jobId of jobIds) {
    try {
      const outcome = await sendOneThankYou(deps, pool, messaging, tenantId, jobId, businessName);
      if (outcome === 'sent') result.sent++;
      else if (outcome === 'suppressed') result.suppressed++;
      else result.deferred++;
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

type SendOutcome = 'sent' | 'suppressed' | 'deferred';

/**
 * T4-F01 dedupe — at most one thank-you per job, matching thankYouSmsSentAt's
 * own scope. Outbound messaging claims the send under `thank_you_sms:{jobId}`,
 * the same key this worker claimed before it moved there.
 */
const THANK_YOU_MESSAGE_KIND = 'thank_you_sms';
function thankYouClaimKey(jobId: string): string {
  return `${THANK_YOU_MESSAGE_KIND}:${jobId}`;
}

/**
 * #1140 — a DISTINCT claim_key namespace from `thankYouClaimKey`, used only
 * to gate the `notification.thank_you_sms.sent` audit write itself (see the
 * audit `withSendClaim` at the bottom of `sendOneThankYou`). The send-claim key above
 * protects the PROVIDER call (at most one real SMS); this one protects the
 * bookkeeping that follows it (at most one audit row), which can be reached
 * by more than one caller once the send-claim is already `'sent'`.
 */
function thankYouAuditClaimKey(jobId: string): string {
  return `thank_you_sms_audit:${jobId}`;
}

async function sendOneThankYou(
  deps: ThankYouSmsWorkerDeps,
  pool: Pool,
  messaging: OutboundMessaging,
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

  // #1184 review (PR #1196) — a job whose SMS ALREADY went out is past every
  // suppression decision. Since #1184 "delivered, audit write failed, job left
  // unstamped" is a normal, retryable state, and the customer can opt out in
  // between — a STOP reply to the thank-you itself lands them on the DNC list,
  // or the owner revokes smsConsent. Running the checks below first would stamp
  // the job with a `suppressed` audit row for a message that was delivered, and
  // the `sent` row would never be written. So learn that the send claim is
  // 'sent' BEFORE any suppression check and go straight to the reconcile.
  if ((await readSendClaimStatus(pool, tenantId, thankYouClaimKey(jobId))) === 'sent') {
    deps.logger.info('Thank-you SMS sweep: send already completed, reconciling audit + stamp', {
      tenantId,
      jobId,
    });
    return recordSentAndStamp(deps, pool, tenantId, jobId, job.customerId);
  }

  const customer = await deps.customerRepo.findById(tenantId, job.customerId);

  // Settings lookup is repeated here only to resolve language; the
  // outer caller already verified the toggle.
  const settings = await deps.settingsRepo.findByTenant(tenantId);
  const language = resolveCustomerLanguage({
    customerPreferredLanguage: customer?.preferredLanguage,
    tenantDefaultLanguage: settings?.defaultLanguage,
  });
  const { body } = renderThankYouSms({ businessName, language });

  // Outbound messaging decides the rest: an automated nudge needs the
  // customer's own consent and a number off the DNC list, waits for their
  // daytime window, and is claimed under the dedupe key BEFORE the provider
  // call, so a crash between the send and the stamp below can't resend it.
  const outcome = await messaging.sendText({
    tenantId,
    recipient: { kind: 'customer', customerId: job.customerId },
    purpose: 'automated_nudge',
    dedupe: { messageKind: THANK_YOU_MESSAGE_KIND, recordId: jobId },
    body,
  });

  if (outcome.status === 'scheduled') {
    // Not sent yet; the claim was released. Leaving the stamp null re-selects
    // the job, and an in-window sweep sends it.
    deps.logger.info('Thank-you SMS sweep: deferred to the recipient send window', {
      tenantId,
      jobId,
      nextAllowedAt: outcome.at.toISOString(),
    });
    return 'deferred';
  }
  if (outcome.status === 'blocked') {
    if (outcome.permanent) {
      // Terminal: the verdict will not change on the next tick, so stamp the
      // job rather than re-selecting it forever.
      await markHandled(
        deps,
        tenantId,
        jobId,
        customer?.id ?? null,
        SUPPRESSION_AUDIT_REASON[outcome.reason] ?? `consent_gate:${outcome.reason}`,
      );
      return 'suppressed';
    }
    // Retryable (the kill switch above all): the per-job catch leaves the
    // stamp null so the next sweep retries.
    throw new Error(
      `thank-you SMS not sent: ${outcome.reason}${outcome.detail ? ` (${outcome.detail})` : ''}`,
    );
  }
  if (outcome.duplicate === 'in_flight') {
    // A genuine concurrent attempt owns this job's send and will stamp it; do
    // nothing here (the winner stamps, so the next sweep won't re-select it).
    deps.logger.info('Thank-you SMS sweep: send in-flight by another attempt, not resending', {
      tenantId,
      jobId,
    });
    return 'suppressed';
  }
  if (outcome.duplicate === 'sent') {
    // A prior attempt sent it but did not stamp the job. Reconcile the stamp
    // idempotently rather than leaving it null: otherwise the eligibility
    // query re-selects this job every tick forever and, ordered oldest-first
    // under LIMIT 500, enough unreconciled rows starve newer eligible jobs
    // (Codex P2, PR #705). The 'sent' pre-check at the top of this function
    // catches the common case; this covers a concurrent attempt finishing the
    // send in between.
    deps.logger.info('Thank-you SMS sweep: send already completed, reconciling missing stamp', {
      tenantId,
      jobId,
    });
  }

  return recordSentAndStamp(deps, pool, tenantId, jobId, job.customerId);
}

/**
 * The bookkeeping for a thank-you SMS that has been delivered: exactly one
 * `notification.thank_you_sms.sent` audit row, then the stamp. Reached by the
 * attempt that just sent, and by every reconcile of an already-'sent' claim.
 */
async function recordSentAndStamp(
  deps: ThankYouSmsWorkerDeps,
  pool: Pool,
  tenantId: string,
  jobId: string,
  customerId: string,
): Promise<SendOutcome> {
  // #1140 — exactly one notification.thank_you_sms.sent audit event per job,
  // however many code paths converge here for the SAME real send: the attempt
  // that just won the send claim, OR a reconcile of an already-'sent' claim
  // running because a prior attempt's own audit/stamp hasn't landed yet — the
  // eligibility SELECT and the stamp UPDATE are not in one transaction, so TWO
  // overlapping sweep ticks can both observe thank_you_sms_sent_at IS NULL for
  // the same already-'sent' claim and both reach this function. A SEPARATE
  // claim_key namespace in the same send_claims ledger turns "write the audit"
  // itself into a claim, so only one of any number of concurrent or sequential
  // callers writes it. No migration — reuses the existing send_claims table.
  //
  // #1184 — and the claim is spent only once the row is WRITTEN. It is taken
  // as 'claimed' and flips to 'sent' only after `auditRepo.create` resolves
  // (withSendClaim's deferred mode: this "send" has no provider phase, so the
  // claim never passes through the never-reclaimed 'sending' state). A throw
  // releases the claim and propagates to the per-job catch; a crash leaves a
  // 'claimed' row that `claimSend` stale-reclaims. Either way the stamp below
  // has NOT been written, so the job is re-selected and the next sweep
  // reconciles the audit (no resend: the SMS claim is already 'sent'). With
  // no auditRepo wired there is nothing to record, so no claim is spent.
  const auditRepo = deps.auditRepo;
  if (auditRepo) {
    const auditClaim = await withSendClaim(
      pool,
      tenantId,
      thankYouAuditClaimKey(jobId),
      async () => {
        // #1184 review (PR #1196) — the audit row and the claim's completion
        // are separate statements (the audit repository runs in its own
        // tenant-scoped transaction), so the row can commit while the
        // completion fails; the claim then stays 'claimed' and a sweep past the
        // stale window reclaims it. Checking for the committed row under the
        // claim makes that reclaim complete the claim instead of writing a
        // second row.
        const existing = await auditRepo.findByEntity(tenantId, 'job', jobId);
        if (existing.some((e) => e.eventType === THANK_YOU_SENT_EVENT)) {
          deps.logger.info('Thank-you SMS sweep: sent audit row already committed, completing its claim', {
            tenantId,
            jobId,
          });
          return;
        }
        await emitAudit(deps, { tenantId, jobId, customerId, outcome: 'sent' });
      },
      undefined,
      { deferSendingUntilProviderStart: true },
    );
    if (auditClaim.outcome === 'duplicate') {
      if (auditClaim.priorStatus !== 'sent') {
        // Another attempt holds the audit claim and has not written the row
        // yet. It stamps once its row lands; if its write fails, the stamp
        // stays null so a later sweep records the audit. Stamping here would
        // strand the job with no audit row.
        deps.logger.info('Thank-you SMS sweep: audit write in flight by another attempt, not stamping', {
          tenantId,
          jobId,
        });
        return 'suppressed';
      }
      deps.logger.info('Thank-you SMS sweep: audit already recorded for this send, skipping duplicate', {
        tenantId,
        jobId,
      });
    }
  }

  await deps.jobRepo.update(tenantId, jobId, {
    thankYouSmsSentAt: (deps.now ?? (() => new Date()))(),
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
        ? THANK_YOU_SENT_EVENT
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
