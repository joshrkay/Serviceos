/**
 * B5.5 / Part F decision F-3 — the SMS-keyword leg of "on my way".
 *
 * `OMW` / "on my way" texted from a REGISTERED TECH phone fires the SAME
 * audited direct status act the app en-route button, the voice leg, and chat
 * use — via the shared technician core, `dispatch/en-route-voice.ts#
 * handleEnRouteForTechnician` (#885: this leg predated the core and used to
 * call `resolveEnRouteAppointment` + `triggerEnRoute` directly with its own
 * inline resolution; it now routes through the same core the other three
 * surfaces do). Never a status claim, never a proposal. Deliberately
 * separate from `handleTechStatusSms` (./handler.ts): "on my way" is an ACT,
 * not a day-long availability status, so it never touches
 * `tech_status_today` or `unavailable_blocks`.
 *
 * Flow:
 *   1. ANTI-SPOOFING: resolve the inbound mobile via P1-022's
 *      findByMobileNumber and require role === 'technician' — same identity
 *      rule the core's other callers each enforce their own way (session
 *      actor on phone, auth subject on chat). A non-tech sender (or an
 *      unknown number) is declined, never actioned. This step stays here —
 *      the core takes identity as already-resolved input, never resolves it
 *      itself.
 *   2. `handleEnRouteForTechnician` resolves the appointment (the tech's OWN
 *      assignments only, next upcoming appointment today — SMS never names
 *      a job, so it's always the bare case) and fires `triggerEnRoute` when
 *      exactly one match exists.
 *   3. SMS has no disambiguation UI, so an ambiguous or empty result is
 *      declined (never a guess) — the dispatcher's capture-all fallback
 *      still threads the text onto the sender's conversation so it isn't
 *      silently dropped.
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
import { AssignmentRepository } from '../../appointments/assignment';
import { AppointmentRepository } from '../../appointments/appointment';
import { AuditRepository, createAuditEvent } from '../../audit/audit';
import {
  handleEnRouteForTechnician,
  technicianNameIfKnown,
  type EnRouteTechnicianDeps,
} from '../../dispatch/en-route-voice';
import { EnRouteEnqueuer } from '../../dispatch/routes';

const logger = createLogger({
  service: 'tech-status-en-route',
  environment: process.env.NODE_ENV || 'dev',
});

export interface EnRouteSmsHandlerDeps extends EnRouteTechnicianDeps {
  userRepo: Pick<UserRepository, 'findByMobileNumber'>;
  // Narrowed from EnRouteTechnicianDeps' optional fields: this handler
  // cannot act at all without them, so callers must always wire them
  // (same contract as before #885 — only the plumbing changed).
  assignmentRepo: Pick<AssignmentRepository, 'findByTechnician'>;
  appointmentRepo: Pick<AppointmentRepository, 'findById'>;
  enRouteCoordinator: EnRouteEnqueuer;
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
    // #885 — resolve + act through the shared technician core. "on my way"
    // over SMS never names a job (the keyword IS the whole message), so no
    // jobReference is threaded — the core takes its bare "next upcoming
    // appointment today" branch, identical to the old inline resolution.
    const technicianName = technicianNameIfKnown(user);
    const outcome = await handleEnRouteForTechnician(deps, {
      tenantId: ctx.tenantId,
      technicianId: user.id,
      ...(technicianName ? { technicianName } : {}),
    });

    if (outcome.kind === 'unavailable') {
      // The only reason reachable here is 'no_timezone' — this handler's
      // deps require assignmentRepo/appointmentRepo/enRouteCoordinator
      // (EnRouteSmsHandlerDeps narrows them from optional), so the core's
      // 'not_wired' branch can never fire through this call site. Without
      // the tenant's zone "today" is undefined, and a UTC fallback can
      // reach the next local day — texting tomorrow's customer. Decline
      // instead; `handled: false` threads the message onto the tech's
      // conversation rather than dropping it.
      return { handled: false };
    }

    if (outcome.kind === 'ambiguous' || outcome.answer.result !== 'found') {
      // SMS has no one-tap disambiguation surface — decline rather than
      // guess. `handled: false` lets the dispatcher's capture-all fallback
      // thread the text onto the tech's conversation instead of dropping it.
      await audit(deps, ctx, 'tech_status.en_route.no_appointment', user.id, {
        outcome: outcome.kind === 'ambiguous' ? 'ambiguous' : 'not_found',
      });
      return {
        handled: false,
        handler: 'en-route-sms',
        reason: outcome.kind === 'ambiguous' ? 'ambiguous' : 'no_upcoming_appointment',
      };
    }

    return {
      handled: true,
      handler: 'en-route-sms',
      reason: outcome.notified ? 'triggered' : 'triggered_no_recipient',
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
