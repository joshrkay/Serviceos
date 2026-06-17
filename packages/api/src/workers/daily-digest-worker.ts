/**
 * RV-061 (F-9) — End-of-Day Digest sweeper.
 *
 * Mirrors the P0-009 cross-tenant sweep pattern (recurring-agreements /
 * estimate-reminder workers): app.ts drives `runDailyDigestSweep` on a
 * 15-minute setInterval behind a leader advisory lock; one tenant's
 * failure is logged and swallowed so the loop keeps going.
 *
 * Per tenant, a digest fires when:
 *   - `digest_enabled` is true, AND
 *   - the tenant-LOCAL `digest_time` falls inside the just-passed sweep
 *     bucket `(now − interval, now]` (tenant-tz wall clock — spring-forward
 *     skips are safe because the bucket scan will simply miss a skipped
 *     minute; fall-back repeats are guarded by a local calendar-date
 *     equality check + the UNIQUE(tenant_id, digest_date) constraint), AND
 *   - no digest row exists yet for the tenant-local "today".
 *
 * Idempotency / double-send guards (tested logically in
 * test/workers/daily-digest-worker.test.ts):
 *   1. `daily_digests` UNIQUE(tenant_id, digest_date): the worker writes
 *      via `insertIfAbsent`; only the inserter proceeds to send.
 *   2. `setSmsDispatchId` only claims when sms_dispatch_id IS NULL — a
 *      stored-but-unsent row (SMS provider failed last sweep) is retried,
 *      while a row that already recorded a dispatch is never re-sent.
 *   3. The dispatch row carries idempotency key `daily_digest:<date>`
 *      (unique per tenant in message_dispatches), so even a same-day
 *      duplicate send attempt dedupes at the provider/audit layer.
 *
 * Note on retry lifetime: a stored-but-unsent row (guard 2 above) will be
 * retried on every sweep until tenant-local midnight, at which point the
 * effective date advances and the orphaned row is accepted by design (the
 * next day's digest is a fresh record; the prior day's unsent row remains
 * in the DB for audit but will not be retried again).
 *
 * Narrative: composed through the BrandVoiceComposer seam when available;
 * ANY composer failure falls back to the deterministic template — the
 * digest must never fail to send because the LLM was down.
 */
import type { Logger } from '../logging/logger';
import type { SettingsRepository, TenantSettings } from '../settings/settings';
import type { MessageDeliveryProvider } from '../notifications/delivery-provider';
import type { DispatchRepository } from '../notifications/dispatch-repository';
import { createOneTapApproveToken } from '../proposals/auto-approve';
import { actionClassForProposalType, type ProposalType } from '../proposals/proposal';
import {
  buildFallbackNarrative,
  computeDigestPayload,
  isBlockingConfidence,
  localDateString,
  renderDigestSms,
  type DailyDigestPayload,
  type DailyDigestRecord,
  type DailyDigestRepository,
  type DigestComputeDeps,
  type DigestSmsApprovalLink,
  type DigestSmsInvoiceLink,
} from '../digest/digest-service';

/** Sweep cadence app.ts drives — and the bucket width for due matching. */
export const DIGEST_SWEEP_INTERVAL_MS = 15 * 60 * 1000;

// ─────────────────────────────────────────────────────────────────────────────
// Tenant-local due-bucket matching
// ─────────────────────────────────────────────────────────────────────────────

/** Minutes since local midnight for `instant` in `timezone`. */
export function localMinutesOfDay(instant: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const m: Record<string, string> = {};
  for (const p of parts) m[p.type] = p.value;
  const hour = Number(m.hour) === 24 ? 0 : Number(m.hour);
  return hour * 60 + Number(m.minute);
}

function parseDigestTimeMinutes(digestTime: string): number | null {
  const match = /^(\d{2}):(\d{2})/.exec(digestTime);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

export interface IsDigestDueInput {
  /** Tenant-local 'HH:MM' (or 'HH:MM:SS' straight from the TIME column). */
  digestTime: string;
  timezone: string;
  now: Date;
  /** Sweep bucket width. Defaults to the 15-minute cadence. */
  intervalMs?: number;
}

export interface DigestDueResult {
  due: boolean;
  /**
   * The tenant-local calendar date the digest should be filed under.
   *
   * When the matching bucket crossed local midnight (wrap branch: target
   * falls in the tail of the previous day, e.g. 23:55 in a 00:05 bucket),
   * the digest belongs to the day that ENDED — `localDateString(now −
   * intervalMs)` — not the new day that started.  In all other cases this
   * equals `localDateString(now)`.
   */
  effectiveDate: string;
}

/**
 * Returns `{ due, effectiveDate }` for the tenant-local `digestTime` bucket
 * `(now − interval, now]`, measured in tenant-local minutes-of-day (wraps
 * across local midnight).
 *
 * `effectiveDate` is the correct YYYY-MM-DD to use for the digest record:
 * for wrap-branch matches (target > prevMin in the midnight-straddle case,
 * confirmed by a local date change) the digest belongs to the previous local
 * day.  During DST fall-back, prevMin > nowMin without a date change — the
 * date-equality guard prevents a false due=true.
 */
export function checkDigestDue(input: IsDigestDueInput): DigestDueResult {
  const intervalMs = input.intervalMs ?? DIGEST_SWEEP_INTERVAL_MS;
  const target = parseDigestTimeMinutes(input.digestTime);
  if (target === null) return { due: false, effectiveDate: localDateString(input.now, input.timezone) };
  const nowMin = localMinutesOfDay(input.now, input.timezone);
  const prevInstant = new Date(input.now.getTime() - intervalMs);
  const prevMin = localMinutesOfDay(prevInstant, input.timezone);
  if (prevMin === nowMin) {
    const due = target === nowMin;
    return { due, effectiveDate: localDateString(input.now, input.timezone) };
  }
  if (prevMin < nowMin) {
    // Normal (non-wrapping) bucket — digest belongs to today.
    const due = target > prevMin && target <= nowMin;
    return { due, effectiveDate: localDateString(input.now, input.timezone) };
  }
  // Bucket wraps local midnight (e.g. prev 23:50 → now 00:05).
  // target > prevMin  → the digest time fell in the PREVIOUS day's tail,
  //                     BUT only when the local calendar date actually changed.
  //                     If the date is the same, prevMin > nowMin because DST
  //                     clocks fell back (e.g. 01:50 CDT → 01:05 CST) — not a
  //                     real midnight crossing.  Require a date change to avoid
  //                     misfiring on the DST fall-back repeat hour.
  // target <= nowMin  → the digest time fell in the NEW day's head.
  if (target > prevMin) {
    // True midnight wrap only when the local calendar date changed.
    if (localDateString(prevInstant, input.timezone) === localDateString(input.now, input.timezone)) {
      // Same local date → DST fall-back repeat, not a midnight crossing.
      return { due: false, effectiveDate: localDateString(input.now, input.timezone) };
    }
    // Matched in the previous day's tail — date it to the day that ended.
    return { due: true, effectiveDate: localDateString(prevInstant, input.timezone) };
  }
  if (target <= nowMin) {
    // Matched in the new day's head — date it to today.
    return { due: true, effectiveDate: localDateString(input.now, input.timezone) };
  }
  return { due: false, effectiveDate: localDateString(input.now, input.timezone) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Sweep
// ─────────────────────────────────────────────────────────────────────────────

export interface DailyDigestWorkerDeps {
  settingsRepo: SettingsRepository;
  digestRepo: DailyDigestRepository;
  /** Repositories `computeDigestPayload` composes over. */
  computeDeps: DigestComputeDeps;
  /** Returns the list of tenant IDs to sweep. */
  listTenantIds: () => Promise<string[]>;
  /**
   * BrandVoiceComposer seam (intent 'digest_narrative'). Optional — when
   * absent (no gateway configured) or when it THROWS, the deterministic
   * fallback narrative is used. The digest never fails over the LLM.
   */
  composeNarrative?: (tenantId: string, payload: DailyDigestPayload) => Promise<string>;
  /** SMS transport. Optional — without it digests are stored, not sent. */
  delivery?: Pick<MessageDeliveryProvider, 'sendSms'>;
  /** message_dispatches audit trail; required when `delivery` is wired. */
  dispatchRepo?: DispatchRepository;
  /** HMAC secret for one-tap approve tokens. Absent → no approval links. */
  oneTapSecret?: string;
  /** Builds the public one-tap approve URL from a signed token. */
  buildApproveUrl?: (token: string) => string;
  /** Web origin for the `/digest/<date>` deep link. */
  publicBaseUrl: string;
  /**
   * U5 (JTBD #7) — record the digest's "APPROVE ALL" anchor over the P2-034
   * transport after the SMS goes out. The reply handler resolves an inbound
   * ALL / APPROVE ALL against it and delegates the ids to the batch-approve
   * path. Optional — absent (no smsEventRepo wired) means the digest still
   * sends with its per-item one-tap links, just no batch reply. Called only
   * after a SUCCESSFUL send and only when there is ≥1 batch-approvable id.
   */
  recordApproveAllAnchor?: (input: {
    tenantId: string;
    proposalIds: string[];
    body: string;
  }) => Promise<void>;
  logger: Logger;
  /** Injectable clock — defaults to `() => new Date()`. */
  now?: () => Date;
  /** Bucket width for due matching; defaults to DIGEST_SWEEP_INTERVAL_MS. */
  intervalMs?: number;
}

export interface DailyDigestSweepResult {
  tenants: number;
  generated: number;
  sent: number;
  /** Dispatches recovered from an existing dispatch row (not re-sent to the provider). */
  claimed: number;
  skipped: number;
  failed: number;
}

export async function runDailyDigestSweep(
  deps: DailyDigestWorkerDeps,
): Promise<DailyDigestSweepResult> {
  const now = (deps.now ?? (() => new Date()))();
  const intervalMs = deps.intervalMs ?? DIGEST_SWEEP_INTERVAL_MS;

  let tenantIds: string[];
  try {
    tenantIds = await deps.listTenantIds();
  } catch (err) {
    deps.logger.error('Daily-digest sweep: failed to list tenants', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { tenants: 0, generated: 0, sent: 0, claimed: 0, skipped: 0, failed: 0 };
  }

  let generated = 0;
  let sent = 0;
  let claimed = 0;
  let skipped = 0;
  let failed = 0;

  for (const tenantId of tenantIds) {
    try {
      const outcome = await processTenant(tenantId, now, intervalMs, deps);
      if (outcome.generated) generated++;
      if (outcome.sent) sent++;
      if (outcome.claimed) claimed++;
      if (outcome.skipped) skipped++;
    } catch (err) {
      // Failure isolation: one tenant's failure never breaks the sweep.
      failed++;
      deps.logger.warn('Daily-digest sweep: tenant failed', {
        tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  deps.logger.info('Daily-digest sweep completed', {
    tenants: tenantIds.length,
    generated,
    sent,
    claimed,
    skipped,
    failed,
  });

  return { tenants: tenantIds.length, generated, sent, claimed, skipped, failed };
}

async function processTenant(
  tenantId: string,
  now: Date,
  intervalMs: number,
  deps: DailyDigestWorkerDeps,
): Promise<{ generated: boolean; sent: boolean; claimed: boolean; skipped: boolean }> {
  const settings = await deps.settingsRepo.findByTenant(tenantId);
  if (!settings || settings.digestEnabled !== true) {
    return { generated: false, sent: false, claimed: false, skipped: false };
  }

  const rawTimezone = settings.timezone || 'America/New_York';
  // Guard against invalid IANA timezone strings stored in tenant settings.
  // Intl throws a RangeError for unknown zones; we fall back to the default
  // and emit a structured warn log once per tenant per sweep invocation.
  const DEFAULT_TIMEZONE = 'America/New_York';
  let timezone = rawTimezone;
  try {
    // Probe the zone with a cheap, side-effect-free format call.
    new Intl.DateTimeFormat('en-US', { timeZone: rawTimezone }).format(now);
  } catch {
    deps.logger.warn('Daily-digest sweep: invalid tenant timezone, falling back to default', {
      tenantId,
      invalidTimezone: rawTimezone,
      fallbackTimezone: DEFAULT_TIMEZONE,
    });
    timezone = DEFAULT_TIMEZONE;
  }

  // Use checkDigestDue to determine BOTH whether the digest is due AND the
  // correct local calendar date for the digest record.  When the matching
  // bucket crosses local midnight (e.g. 23:55 digest_time, bucket 23:50→00:05),
  // the digest belongs to the day that ENDED, not the new day that started.
  const dueResult = checkDigestDue({
    digestTime: settings.digestTime ?? '18:00',
    timezone,
    now,
    intervalMs,
  });

  // The effective date drives both the due-check and the stored-row lookup.
  // A prior sweep may have stored a row (inserted=true) but failed to send;
  // that row must be retried even when the current bucket is no longer due.
  const digestDate = dueResult.effectiveDate;

  // Look up any stored row for this date — catches both the normal retry
  // case and the midnight-wrap case where the effective date is yesterday.
  const existing = await deps.digestRepo.findByTenantAndDate(tenantId, digestDate);
  if (existing?.smsDispatchId) {
    // Already generated AND sent today — re-delivery / overlap no-op.
    return { generated: false, sent: false, claimed: false, skipped: true };
  }

  let record: DailyDigestRecord;
  let generated = false;

  if (existing) {
    // Stored on an earlier tick but the SMS never went out (provider
    // failure) — retry the send from the stored snapshot without
    // recomputing, regardless of the due bucket.
    record = existing;
  } else {
    if (!dueResult.due) return { generated: false, sent: false, claimed: false, skipped: false };

    const payload = await computeDigestPayload(tenantId, digestDate, deps.computeDeps);
    const narrative = await composeNarrativeSafe(tenantId, payload, deps);

    const { digest, inserted } = await deps.digestRepo.insertIfAbsent(
      tenantId,
      digestDate,
      payload,
      narrative,
    );
    if (!inserted) {
      // Lost the UNIQUE(tenant, date) race — the inserter owns the send.
      deps.logger.info('Daily-digest sweep: lost insert race, skipping send', {
        tenantId,
        digestDate,
      });
      return { generated: false, sent: false, claimed: false, skipped: true };
    }
    record = digest;
    generated = true;
  }

  const smsOutcome = await sendDigestSms(tenantId, record, settings, deps);
  return {
    generated,
    sent: smsOutcome === 'sent',
    claimed: smsOutcome === 'claimed',
    skipped: false,
  };
}

async function composeNarrativeSafe(
  tenantId: string,
  payload: DailyDigestPayload,
  deps: DailyDigestWorkerDeps,
): Promise<string> {
  if (deps.composeNarrative) {
    try {
      const text = (await deps.composeNarrative(tenantId, payload)).trim();
      if (text.length > 0) return text;
    } catch (err) {
      deps.logger.warn('Daily-digest sweep: narrative composition failed, using fallback', {
        tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return buildFallbackNarrative(payload);
}

async function sendDigestSms(
  tenantId: string,
  record: DailyDigestRecord,
  settings: TenantSettings,
  deps: DailyDigestWorkerDeps,
): Promise<'sent' | 'claimed' | false> {
  if ((settings.digestChannel ?? 'sms') !== 'sms') {
    // 'none' — digest is stored for the web view; no SMS.
    return false;
  }
  if (!deps.delivery || !deps.dispatchRepo) {
    deps.logger.info('Daily-digest sweep: no SMS transport wired, digest stored only', {
      tenantId,
      digestDate: record.digestDate,
    });
    return false;
  }
  if (!settings.ownerPhone) {
    deps.logger.warn('Daily-digest sweep: tenant has no owner_phone, digest stored only', {
      tenantId,
      digestDate: record.digestDate,
    });
    return false;
  }

  // Before sending, check whether a dispatch already exists for this digest.
  // This guards the retry path: a prior sweep that stored the row but crashed
  // before claiming `setSmsDispatchId` must not re-send the SMS.
  const existingDispatches = await deps.dispatchRepo.findByEntity(tenantId, 'daily_digest', record.id);
  if (existingDispatches.length > 0) {
    const prior = existingDispatches[0]; // sorted sent_at DESC by the repo
    const claimResult = await deps.digestRepo.setSmsDispatchId(tenantId, record.digestDate, prior.id);
    if (!claimResult) {
      deps.logger.info('Daily-digest sweep: dispatch already claimed by another sender (retry path)', {
        tenantId,
        digestDate: record.digestDate,
        dispatchId: prior.id,
      });
    }
    deps.logger.info('Daily-digest sweep: claimed existing dispatch, no re-send', {
      tenantId,
      digestDate: record.digestDate,
      dispatchId: prior.id,
    });
    return 'claimed';
  }

  const body = renderDigestSms({
    payload: record.payload,
    deepLinkUrl: `${deps.publicBaseUrl.replace(/\/+$/, '')}/digest/${record.digestDate}`,
    approvalLinks: buildApprovalLinks(tenantId, record.payload, deps),
    // RV-065 — "invoice it" one-tap links for completed-unbilled jobs.
    // Lowest budget priority inside renderDigestSms (dropped first).
    invoiceLinks: buildInvoiceLinks(tenantId, record.payload, deps),
  });

  const idempotencyKey = `daily_digest:${record.digestDate}`;
  const result = await deps.delivery.sendSms({
    to: settings.ownerPhone,
    body,
    tenantId,
    idempotencyKey,
  });

  let dispatch;
  try {
    dispatch = await deps.dispatchRepo.create({
      tenantId,
      entityType: 'daily_digest',
      entityId: record.id,
      channel: 'sms',
      recipient: settings.ownerPhone,
      provider: result.provider,
      providerMessageId: result.providerMessageId,
      status: 'sent',
      idempotencyKey,
    });
  } catch (createErr) {
    // Unique-violation: another concurrent sender committed the dispatch row
    // first. Look it up and claim it so setSmsDispatchId still fires.
    deps.logger.info('Daily-digest sweep: dispatch create unique-violation, looking up existing row', {
      tenantId,
      digestDate: record.digestDate,
      error: createErr instanceof Error ? createErr.message : String(createErr),
    });
    const fallbackDispatches = await deps.dispatchRepo.findByEntity(tenantId, 'daily_digest', record.id);
    if (fallbackDispatches.length === 0) {
      throw createErr; // unexpected — rethrow for observability
    }
    dispatch = fallbackDispatches[0];
  }

  const claimedNew = await deps.digestRepo.setSmsDispatchId(
    tenantId,
    record.digestDate,
    dispatch.id,
  );
  if (!claimedNew) {
    // Status check lost: another sender recorded a dispatch first. The
    // provider-level idempotency key bounds the blast radius to one SMS.
    deps.logger.warn('Daily-digest sweep: dispatch already recorded by another sender', {
      tenantId,
      digestDate: record.digestDate,
    });
  }

  // U5 (JTBD #7) — anchor the day's batch-approvable ids over the P2-034
  // transport so an inbound "APPROVE ALL" can delegate to batch-approve.
  // Only the inserter that actually claimed the dispatch records the anchor
  // (claimedNew), keeping it 1:1 with the single SMS that went out — a
  // retry/loser sweep must not append a second, stale anchor.
  if (deps.recordApproveAllAnchor && claimedNew) {
    const approveAllIds = batchApprovableProposalIds(record.payload);
    if (approveAllIds.length > 0) {
      try {
        await deps.recordApproveAllAnchor({
          tenantId,
          proposalIds: approveAllIds,
          body,
        });
      } catch (anchorErr) {
        // Best-effort: the digest already sent. A missing anchor only means
        // the owner must approve per-item (one-tap) instead of via ALL.
        deps.logger.warn('Daily-digest sweep: failed to record APPROVE ALL anchor', {
          tenantId,
          digestDate: record.digestDate,
          error: anchorErr instanceof Error ? anchorErr.message : String(anchorErr),
        });
      }
    }
  }

  return 'sent';
}

/**
 * Track-E gating shared by the per-item one-tap links and the U5 "APPROVE
 * ALL" anchor: a proposal is single-tap / batch approvable ONLY when its
 * confidence isn't blocking AND its action class is `capture`. Money / comms /
 * irreversible (non-capture) and low/very_low-confidence proposals still
 * surface in the digest deep link for in-app review, but never carry a bare
 * approve affordance — mirroring the chain-send `suppressApproveLink`
 * invariant and the SMS Y-reply class refusal. Unknown class fails closed.
 */
function isBatchApprovable(approval: DailyDigestPayload['pendingApprovals']['top'][number]): boolean {
  if (isBlockingConfidence(approval.overallConfidence)) return false;
  return actionClassForProposalType(approval.proposalType as ProposalType) === 'capture';
}

/**
 * U5 (JTBD #7) — the proposal ids the "APPROVE ALL" reply may batch-approve:
 * exactly the ones that pass the one-tap gates above. Computed independently
 * of the one-tap secret (the anchor records the set even when no links were
 * minted) so the reply transport and the rendered links never diverge.
 */
export function batchApprovableProposalIds(payload: DailyDigestPayload): string[] {
  return payload.pendingApprovals.top
    .filter(isBatchApprovable)
    .map((approval) => approval.proposalId);
}

export function buildApprovalLinks(
  tenantId: string,
  payload: DailyDigestPayload,
  deps: DailyDigestWorkerDeps,
): DigestSmsApprovalLink[] {
  if (!deps.oneTapSecret || !deps.buildApproveUrl) return [];
  const buildUrl = deps.buildApproveUrl;
  const secret = deps.oneTapSecret;
  const links: DigestSmsApprovalLink[] = [];
  for (const approval of payload.pendingApprovals.top) {
    if (!isBatchApprovable(approval)) continue;
    // TTL is clamped to ≤30 min inside createOneTapApproveToken.
    const { token } = createOneTapApproveToken({
      proposalId: approval.proposalId,
      tenantId,
      secret,
    });
    links.push({ approval, url: buildUrl(token) });
  }
  return links;
}

/**
 * RV-065 — one "invoice it" link per completed-unbilled job in the digest
 * payload. The token's action discriminator is 'mint_draft_invoice' and it
 * binds tenant+jobId; tapping it mints a draft_invoice proposal for the job
 * and redirects into the standard one-tap approve page. Same secret /
 * nonce / ≤30-min TTL machinery as the approve links.
 */
function buildInvoiceLinks(
  tenantId: string,
  payload: DailyDigestPayload,
  deps: DailyDigestWorkerDeps,
): DigestSmsInvoiceLink[] {
  if (!deps.oneTapSecret || !deps.buildApproveUrl) return [];
  const buildUrl = deps.buildApproveUrl;
  const secret = deps.oneTapSecret;
  return payload.unbilledJobs.map((job) => {
    const { token } = createOneTapApproveToken({
      action: 'mint_draft_invoice',
      jobId: job.jobId,
      tenantId,
      secret,
    });
    return { job, url: buildUrl(token) };
  });
}
