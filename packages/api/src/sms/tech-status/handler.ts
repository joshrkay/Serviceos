import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../../logging/logger';
import {
  InboundSmsContext,
  HandlerResult,
} from '../inbound-dispatch';
import {
  techStatusForKeyword,
  type TechStatus,
} from '@ai-service-os/shared';
import { UserRepository } from '../../users/user';
import { SettingsRepository } from '../../settings/settings';
import { UnavailableBlockRepository, createUnavailableBlock } from '../../availability/unavailable-block';
import { AuditRepository, createAuditEvent } from '../../audit/audit';
import { tzMidnight, addCalendarDays, isValidTimezone } from '../../shared/timezone';
import { TechStatusTodayRepository } from './idempotency';
import {
  createRescheduleProposalsFromTechOut,
  RescheduleFromTechOutDeps,
} from '../../scheduling/reschedule/from-tech-out';

/**
 * P6-028 — tech "I'm out today" SMS handler.
 *
 * Flow (after the keyword dispatcher routes OUT|SICK|UNAVAILABLE here):
 *   1. Resolve the inbound mobile to a user via P1-022's findByMobileNumber
 *      and ANTI-SPOOFING role-check: only role === 'technician' may mark a
 *      tech out. The owner's own mobile must NOT mark a tech out. The body is
 *      never trusted for identity.
 *   2. Derive the tech's TENANT-LOCAL date from tenant_settings.timezone.
 *   3. Claim the day in tech_status_today (idempotency + implicit midnight
 *      clear). A second OUT the same local day is a no-op.
 *   4. Write a same-day unavailable_blocks row (tenant-local midnight → +24h).
 *   5. Walk the tech's remaining appointments today and create one
 *      reschedule_appointment proposal each, with a brand-voice customer SMS
 *      draft attached. The owner approves (one tap / APPROVE ALL).
 *
 * NEVER throws — the inbound dispatcher contract requires a structured result
 * (a throw would make Twilio retry an already-acknowledged delivery).
 */

const DEFAULT_TIMEZONE = 'America/New_York';

const logger = createLogger({
  service: 'tech-status',
  environment: process.env.NODE_ENV || 'dev',
});

export interface TechStatusHandlerDeps {
  userRepo: UserRepository;
  settingsRepo: SettingsRepository;
  unavailableBlockRepo: UnavailableBlockRepository;
  techStatusTodayRepo: TechStatusTodayRepository;
  rescheduleDeps: RescheduleFromTechOutDeps;
  auditRepo?: AuditRepository;
  /** Override "now" for deterministic tests. Defaults to `new Date()`. */
  now?: () => Date;
}

/**
 * Compute the tenant-local calendar date (YYYY-MM-DD) for the given instant.
 * "Today" is the tech's tenant-local day, NOT server-local time.
 */
export function tenantLocalDate(now: Date, tz: string): string {
  const zone = isValidTimezone(tz) ? tz : 'UTC';
  // en-CA formats as YYYY-MM-DD; the timeZone option does the tz math.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

async function audit(
  deps: TechStatusHandlerDeps,
  ctx: InboundSmsContext,
  eventType: string,
  entityId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  if (!deps.auditRepo) return;
  await deps.auditRepo.create(
    createAuditEvent({
      tenantId: ctx.tenantId,
      actorId: entityId || 'unknown',
      actorRole: 'system',
      eventType,
      entityType: 'tech_status',
      entityId: entityId || ctx.messageSid,
      metadata: { ...metadata, messageSid: ctx.messageSid, fromE164: ctx.fromE164 },
    }),
  );
}

export async function handleTechStatusSms(
  ctx: InboundSmsContext,
  deps: TechStatusHandlerDeps,
): Promise<HandlerResult> {
  const now = (deps.now ?? (() => new Date()))();

  // Re-derive the status from the body — never trust an unexpected token even
  // though the dispatcher only routes registered keywords.
  const firstToken = ctx.body.trim().split(/\s+/, 1)[0] ?? '';
  const status: TechStatus | null = techStatusForKeyword(firstToken);
  if (!status) {
    return { handled: false, handler: 'tech-status', reason: 'unrecognized_keyword' };
  }

  // 1. ANTI-SPOOFING: resolve the inbound mobile + enforce technician role.
  const user = await deps.userRepo.findByMobileNumber(ctx.tenantId, ctx.fromE164);
  if (!user || user.role !== 'technician') {
    // Truthful: Twilio HAS seen the message; we just won't act on it. This is
    // NOT handled:true — the message was not actioned by this feature.
    await audit(deps, ctx, 'tech_status.unverified_mobile', user?.id ?? '', {
      reason: user ? 'not_a_technician' : 'unknown_mobile',
      resolvedRole: user?.role ?? null,
    });
    return { handled: false, handler: 'tech-status', reason: 'unknown_mobile' };
  }

  // 2. Tenant-local "today".
  const settings = await deps.settingsRepo.findByTenant(ctx.tenantId);
  const tz = settings?.timezone || DEFAULT_TIMEZONE;
  const localDate = tenantLocalDate(now, tz);

  // 3. Idempotency claim (also gives us "midnight clear" for free via the PK).
  const claimed = await deps.techStatusTodayRepo.claimToday({
    tenantId: ctx.tenantId,
    technicianId: user.id,
    localDate,
    status,
    sourceMessageSid: ctx.messageSid,
  });
  if (!claimed) {
    await audit(deps, ctx, 'tech_status.duplicate', user.id, { localDate, status });
    return { handled: true, handler: 'tech-status', reason: 'already_recorded' };
  }

  // Steps 4-5 run AFTER the idempotency claim, so a mid-flow failure would
  // leave the day claimed ("handled") while the block / reschedules never
  // landed — and the next sweep would short-circuit on the existing claim,
  // permanently stranding the customer reschedules. Wrap them: on failure we
  // release the claim so a retry re-attempts from a clean slate. (The block
  // INSERT may re-run on retry; a duplicate same-day block is benign — the day
  // is unavailable either way — whereas duplicate proposals or stranded
  // reschedules are not.)
  let block: ReturnType<typeof createUnavailableBlock>;
  let proposals: Awaited<
    ReturnType<typeof createRescheduleProposalsFromTechOut>
  >['proposals'];
  try {
    // 4. Same-day unavailable block: tenant-local midnight → +24h.
    const dayStart = tzMidnight(localDate, tz);
    const dayEnd = addCalendarDays(dayStart, 1, tz);
    block = createUnavailableBlock({
      tenantId: ctx.tenantId,
      technicianId: user.id,
      startTime: dayStart,
      endTime: dayEnd,
      reason: status,
      createdBy: user.id,
    });
    await deps.unavailableBlockRepo.create(block);

    // 5. Walk remaining appointments today → create reschedule proposals with a
    //    brand-voice customer SMS draft attached to each.
    const windowStart = now;
    ({ proposals } = await createRescheduleProposalsFromTechOut(
      {
        tenantId: ctx.tenantId,
        technicianId: user.id,
        windowStart,
        windowEnd: dayEnd,
        createdBy: user.id,
        reason: status,
      },
      deps.rescheduleDeps,
    ));
  } catch (err) {
    // Log the underlying cause (with stack) — previously the failure was only
    // written to an audit row, so a processing failure was invisible in logs
    // and CI. The stack pinpoints whether the block insert or the reschedule
    // proposal creation threw.
    logger.error('tech-status processing failed', {
      tenantId: ctx.tenantId,
      technicianId: user.id,
      localDate,
      status,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    await deps.techStatusTodayRepo.releaseToday(ctx.tenantId, user.id, localDate);
    await audit(deps, ctx, 'tech_status.processing_failed', user.id, {
      localDate,
      status,
      error: err instanceof Error ? err.message : String(err),
    });
    return { handled: false, handler: 'tech-status', reason: 'processing_failed' };
  }

  await audit(deps, ctx, 'tech_status.recorded', user.id, {
    localDate,
    status,
    unavailableBlockId: block.id,
    proposalCount: proposals.length,
    proposalIds: proposals.map((p) => p.id),
  });

  return {
    handled: true,
    handler: 'tech-status',
    reason: 'recorded',
  };
}

/** Generate a system actor id where one is needed but no user resolved. */
export function systemActorId(): string {
  return uuidv4();
}
