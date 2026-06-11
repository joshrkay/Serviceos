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
 *     bucket `(now − interval, now]` (tenant-tz wall clock — DST handled
 *     by Intl, same approach as the money-dashboard bucketing), AND
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
 * Narrative: composed through the BrandVoiceComposer seam when available;
 * ANY composer failure falls back to the deterministic template — the
 * digest must never fail to send because the LLM was down.
 */
import type { Logger } from '../logging/logger';
import type { SettingsRepository, TenantSettings } from '../settings/settings';
import type { MessageDeliveryProvider } from '../notifications/delivery-provider';
import type { DispatchRepository } from '../notifications/dispatch-repository';
import { createOneTapApproveToken } from '../proposals/auto-approve';
import {
  buildFallbackNarrative,
  computeDigestPayload,
  localDateString,
  renderDigestSms,
  type DailyDigestPayload,
  type DailyDigestRecord,
  type DailyDigestRepository,
  type DigestComputeDeps,
  type DigestSmsApprovalLink,
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

/**
 * True when the tenant-local `digestTime` wall-clock falls inside the
 * just-passed bucket `(now − interval, now]`, measured in tenant-local
 * minutes-of-day (wraps across local midnight).
 */
export function isDigestDue(input: IsDigestDueInput): boolean {
  const intervalMs = input.intervalMs ?? DIGEST_SWEEP_INTERVAL_MS;
  const target = parseDigestTimeMinutes(input.digestTime);
  if (target === null) return false;
  const nowMin = localMinutesOfDay(input.now, input.timezone);
  const prevMin = localMinutesOfDay(new Date(input.now.getTime() - intervalMs), input.timezone);
  if (prevMin === nowMin) {
    // Degenerate sub-minute interval: only an exact match is due.
    return target === nowMin;
  }
  if (prevMin < nowMin) {
    return target > prevMin && target <= nowMin;
  }
  // Bucket wraps local midnight (e.g. prev 23:50 → now 00:05).
  return target > prevMin || target <= nowMin;
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
    return { tenants: 0, generated: 0, sent: 0, skipped: 0, failed: 0 };
  }

  let generated = 0;
  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const tenantId of tenantIds) {
    try {
      const outcome = await processTenant(tenantId, now, intervalMs, deps);
      if (outcome.generated) generated++;
      if (outcome.sent) sent++;
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
    skipped,
    failed,
  });

  return { tenants: tenantIds.length, generated, sent, skipped, failed };
}

async function processTenant(
  tenantId: string,
  now: Date,
  intervalMs: number,
  deps: DailyDigestWorkerDeps,
): Promise<{ generated: boolean; sent: boolean; skipped: boolean }> {
  const settings = await deps.settingsRepo.findByTenant(tenantId);
  if (!settings || settings.digestEnabled !== true) {
    return { generated: false, sent: false, skipped: false };
  }

  const timezone = settings.timezone || 'America/New_York';
  const digestDate = localDateString(now, timezone);

  const existing = await deps.digestRepo.findByTenantAndDate(tenantId, digestDate);
  if (existing?.smsDispatchId) {
    // Already generated AND sent today — re-delivery / overlap no-op.
    return { generated: false, sent: false, skipped: true };
  }

  let record: DailyDigestRecord;
  let generated = false;

  if (existing) {
    // Stored on an earlier tick but the SMS never went out (provider
    // failure) — retry the send from the stored snapshot without
    // recomputing, regardless of the due bucket.
    record = existing;
  } else {
    const due = isDigestDue({
      digestTime: settings.digestTime ?? '18:00',
      timezone,
      now,
      intervalMs,
    });
    if (!due) return { generated: false, sent: false, skipped: false };

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
      return { generated: false, sent: false, skipped: true };
    }
    record = digest;
    generated = true;
  }

  const smsSent = await sendDigestSms(tenantId, record, settings, deps);
  return { generated, sent: smsSent, skipped: false };
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
): Promise<boolean> {
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

  const body = renderDigestSms({
    payload: record.payload,
    deepLinkUrl: `${deps.publicBaseUrl.replace(/\/+$/, '')}/digest/${record.digestDate}`,
    approvalLinks: buildApprovalLinks(tenantId, record.payload, deps),
  });

  const idempotencyKey = `daily_digest:${record.digestDate}`;
  const result = await deps.delivery.sendSms({
    to: settings.ownerPhone,
    body,
    tenantId,
    idempotencyKey,
  });

  const dispatch = await deps.dispatchRepo.create({
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

  const claimed = await deps.digestRepo.setSmsDispatchId(
    tenantId,
    record.digestDate,
    dispatch.id,
  );
  if (!claimed) {
    // Status check lost: another sender recorded a dispatch first. The
    // provider-level idempotency key bounds the blast radius to one SMS.
    deps.logger.warn('Daily-digest sweep: dispatch already recorded by another sender', {
      tenantId,
      digestDate: record.digestDate,
    });
  }
  return true;
}

function buildApprovalLinks(
  tenantId: string,
  payload: DailyDigestPayload,
  deps: DailyDigestWorkerDeps,
): DigestSmsApprovalLink[] {
  if (!deps.oneTapSecret || !deps.buildApproveUrl) return [];
  const buildUrl = deps.buildApproveUrl;
  const secret = deps.oneTapSecret;
  return payload.pendingApprovals.top.map((approval) => {
    // TTL is clamped to ≤30 min inside createOneTapApproveToken.
    const { token } = createOneTapApproveToken({
      proposalId: approval.proposalId,
      tenantId,
      secret,
    });
    return { approval, url: buildUrl(token) };
  });
}
