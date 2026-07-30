/**
 * B5.5 / Part F decision F-3 — the SMS-keyword leg of "on my way".
 *
 * `OMW` / "on my way" texted from a REGISTERED TECH phone fires the SAME
 * audited direct status act the app en-route button and the voice leg use
 * (dispatch/routes.ts `triggerEnRoute`) — never a status claim, never a
 * proposal. Deliberately separate from `handleTechStatusSms`
 * (./handler.ts): "on my way" is an ACT, not a day-long availability status,
 * so it never touches `tech_status_today` or `unavailable_blocks`.
 *
 * Flow:
 *   1. ANTI-SPOOFING: resolve the inbound mobile via P1-022's
 *      findByMobileNumber and require role === 'technician' — same identity
 *      rule as the tech-status handler. A non-tech sender (or an unknown
 *      number) is declined, never actioned.
 *   2. Resolve the appointment via the SAME speaker-scoped resolver the
 *      voice leg uses (dispatch/en-route-voice.ts resolveEnRouteAppointment)
 *      — the tech's OWN assignments only, next upcoming appointment today.
 *   3. Exactly one match → `triggerEnRoute`. SMS has no disambiguation UI,
 *      so an ambiguous or empty result is declined (never a guess) — the
 *      dispatcher's capture-all fallback still threads the text onto the
 *      sender's conversation so it isn't silently dropped.
 *
 * NEVER throws — the inbound dispatcher contract requires a structured
 * result (a throw would make Twilio retry an already-acknowledged delivery).
 */
import { createLogger } from '../../logging/logger';
import {
  InboundSmsContext,
  HandlerResult,
  KeywordHandler,
} from '../inbound-dispatch';
import { EN_ROUTE_SMS_KEYWORDS } from '@ai-service-os/shared';
import { UserRepository } from '../../users/user';
import { SettingsRepository } from '../../settings/settings';
import { AssignmentRepository } from '../../appointments/assignment';
import { AppointmentRepository } from '../../appointments/appointment';
import { JobRepository } from '../../jobs/job';
import { AuditRepository, createAuditEvent } from '../../audit/audit';
import {
  resolveEnRouteAppointment,
  resolveTodayBoundary,
} from '../../dispatch/en-route-voice';
import { triggerEnRoute, EnRouteEnqueuer } from '../../dispatch/routes';

const logger = createLogger({
  service: 'tech-status-en-route',
  environment: process.env.NODE_ENV || 'dev',
});

export interface EnRouteSmsHandlerDeps {
  userRepo: Pick<UserRepository, 'findByMobileNumber'>;
  settingsRepo?: Pick<SettingsRepository, 'findByTenant'>;
  assignmentRepo: Pick<AssignmentRepository, 'findByTechnician'>;
  appointmentRepo: Pick<AppointmentRepository, 'findById'>;
  jobRepo?: Pick<JobRepository, 'findById'>;
  enRouteCoordinator: EnRouteEnqueuer;
  auditRepo?: AuditRepository;
  /** Override "now" for deterministic tests. Defaults to `new Date()`. */
  now?: () => Date;
}

async function audit(
  deps: EnRouteSmsHandlerDeps,
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

export async function handleEnRouteSms(
  ctx: InboundSmsContext,
  deps: EnRouteSmsHandlerDeps,
): Promise<HandlerResult> {
  // 1. ANTI-SPOOFING: resolve the inbound mobile + enforce technician role.
  // Mirrors handleTechStatusSms step 1 exactly — DNC/consent handling for
  // the OUTBOUND customer SMS this triggers is untouched: it lives entirely
  // inside DelayNotificationCoordinator.enqueueEnRouteNotice (the same
  // coordinator the app button and the voice leg call through
  // `triggerEnRoute`), which this handler never bypasses.
  const user = await deps.userRepo.findByMobileNumber(ctx.tenantId, ctx.fromE164);
  if (!user || user.role !== 'technician') {
    await audit(deps, ctx, 'tech_status.en_route.unverified_mobile', user?.id ?? '', {
      reason: user ? 'not_a_technician' : 'unknown_mobile',
      resolvedRole: user?.role ?? null,
    });
    return { handled: false, handler: 'en-route-sms', reason: user ? 'not_a_technician' : 'unknown_mobile' };
  }

  try {
    const now = deps.now ? deps.now() : new Date();
    const dayBoundary = await resolveTodayBoundary(deps.settingsRepo, ctx.tenantId, now);
    // Without the tenant's zone "today" is undefined, and a UTC fallback can
    // reach the next local day — texting tomorrow's customer. Decline instead;
    // `handled: false` threads the message onto the tech's conversation
    // rather than dropping it.
    if (!dayBoundary) return { handled: false };

    // Speaker-scoped resolution — the SAME resolver the voice leg uses.
    // "on my way" over SMS never names a job (the keyword IS the whole
    // message), so this is always the bare "next upcoming appointment
    // today" case.
    const resolution = await resolveEnRouteAppointment(
      { assignmentRepo: deps.assignmentRepo, appointmentRepo: deps.appointmentRepo, jobRepo: deps.jobRepo },
      { tenantId: ctx.tenantId, technicianId: user.id, now, dayBoundary },
    );

    if (resolution.kind !== 'resolved') {
      // SMS has no one-tap disambiguation surface — decline rather than
      // guess. `handled: false` lets the dispatcher's capture-all fallback
      // thread the text onto the tech's conversation instead of dropping it.
      await audit(deps, ctx, 'tech_status.en_route.no_appointment', user.id, {
        outcome: resolution.kind,
      });
      return {
        handled: false,
        handler: 'en-route-sms',
        reason: resolution.kind === 'ambiguous' ? 'ambiguous' : 'no_upcoming_appointment',
      };
    }

    const technicianName =
      [user.firstName, user.lastName].filter(Boolean).join(' ').trim() || user.email;

    const trigger = await triggerEnRoute(
      { enRouteCoordinator: deps.enRouteCoordinator, auditRepo: deps.auditRepo },
      {
        tenantId: ctx.tenantId,
        appointmentId: resolution.appointmentId,
        technicianName,
        actor: { tenantId: ctx.tenantId, userId: user.id, role: 'technician' },
      },
    );

    return {
      handled: true,
      handler: 'en-route-sms',
      reason: trigger.notified ? 'triggered' : 'triggered_no_recipient',
    };
  } catch (err) {
    logger.error('en-route SMS processing failed', {
      tenantId: ctx.tenantId,
      technicianId: user.id,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    await audit(deps, ctx, 'tech_status.en_route.processing_failed', user.id, {
      error: err instanceof Error ? err.message : String(err),
    });
    return { handled: false, handler: 'en-route-sms', reason: 'processing_failed' };
  }
}

/**
 * The P2-034 `KeywordHandler` for the en-route SMS keyword(s)
 * ('omw' / 'on my way'). Registered SEPARATELY from
 * `TechStatusKeywordHandler` (./keyword-router.ts) — different keyword set,
 * different handler, different act.
 */
export class EnRouteSmsKeywordHandler implements KeywordHandler {
  readonly keywords: readonly string[] = EN_ROUTE_SMS_KEYWORDS;

  constructor(private readonly deps: EnRouteSmsHandlerDeps) {}

  async handle(ctx: InboundSmsContext): Promise<HandlerResult> {
    return handleEnRouteSms(ctx, this.deps);
  }
}
