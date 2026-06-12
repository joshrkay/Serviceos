/**
 * RV-116 — dropped-call recovery resume handler.
 *
 * Consulted by the inbound-SMS dispatcher LAST (after keyword routing and
 * the owner-edit fallback both decline). Thread matching is the durable
 * `dropped_call_recoveries` row for (tenant, caller phone) within the resume
 * window — the same row RV-115 stamped with the FSM context.
 *
 * Behavior by context bucket:
 *
 *   - proposal_created with a still-open proposal → "confirm pending
 *     booking": reply with the status cue (the human approval gate still
 *     owns execution — a customer SMS can never approve a proposal) and
 *     audit the resume against the proposal.
 *   - anything else (mid-intent / early / proposal already resolved) →
 *     create a `call_me_back` task (reason 'dropped_call_resume',
 *     scheduledFor now) and tell the caller a human will ring back.
 *
 * Both paths mark the message handled so the webhook's unhandled-audit path
 * stays quiet for genuine recovery replies.
 */
import type {
  InboundSmsContext,
  HandlerResult,
  RecoveryResumeHandler,
} from '../inbound-dispatch';
import type { DroppedCallRecoveryRepository } from './scheduler';
import type { Proposal, ProposalRepository } from '../../proposals/proposal';
import type { CallMeBackRepository } from '../../voice/call-me-back/call-me-back';
import { AuditRepository, createAuditEvent } from '../../audit/audit';
import type { Logger } from '../../logging/logger';

/** Replies older than this no longer resume a thread (mirrors the B5 TTL). */
export const RESUME_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Proposal statuses that still count as "pending" for the booking cue. */
const OPEN_PROPOSAL_STATUSES: ReadonlySet<string> = new Set([
  'draft',
  'ready_for_review',
  'approved',
  'executing',
]);

export interface DroppedCallResumeDeps {
  recoveryRepo: Pick<DroppedCallRecoveryRepository, 'findRecentByPhone'>;
  proposalRepo?: Pick<ProposalRepository, 'findById'>;
  callMeBackRepo?: CallMeBackRepository;
  /** Reply transport (same delivery provider the recovery SMS used). */
  sendSms: (args: { to: string; body: string }) => Promise<unknown>;
  auditRepo?: AuditRepository;
  logger?: Logger;
  businessName?: string;
  now?: () => Date;
  windowMs?: number;
}

export function composeBookingStatusReply(businessName: string): string {
  return (
    `${businessName}: thanks for getting back to us — we saved your request ` +
    `from the call and it's with our team for confirmation. You'll get a ` +
    `text as soon as it's locked in.`
  );
}

export function composeCallbackReply(businessName: string): string {
  return (
    `${businessName}: thanks for getting back to us — someone will call you ` +
    `right back to pick up where we left off.`
  );
}

export function createDroppedCallResumeHandler(
  deps: DroppedCallResumeDeps,
): RecoveryResumeHandler {
  const businessName = deps.businessName ?? 'Your shop';
  const now = deps.now ?? (() => new Date());
  const windowMs = deps.windowMs ?? RESUME_WINDOW_MS;

  async function audit(
    ctx: InboundSmsContext,
    outcome: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    if (!deps.auditRepo) return;
    try {
      await deps.auditRepo.create(
        createAuditEvent({
          tenantId: ctx.tenantId,
          actorId: 'system:dropped-call-resume',
          actorRole: 'system',
          eventType: 'dropped_call_recovery.resumed',
          entityType: 'sms_message',
          entityId: ctx.messageSid,
          metadata: { outcome, ...metadata },
        }),
      );
    } catch {
      /* audit is best-effort */
    }
  }

  return {
    name: 'dropped-call-resume',
    async handle(ctx: InboundSmsContext): Promise<HandlerResult> {
      const since = new Date(now().getTime() - windowMs);
      const row = await deps.recoveryRepo.findRecentByPhone(
        ctx.tenantId,
        ctx.fromE164,
        since,
      );
      if (!row) {
        return { handled: false, handler: 'dropped-call-resume', reason: 'no_recovery_thread' };
      }

      // Bucket 1 — a proposal was queued before the drop and is still open:
      // confirm the pending booking by status cue.
      if (deps.proposalRepo && row.context && row.context.proposalIds.length > 0) {
        let openProposal: Proposal | null = null;
        for (const proposalId of row.context.proposalIds) {
          try {
            const p = await deps.proposalRepo.findById(ctx.tenantId, proposalId);
            if (p && OPEN_PROPOSAL_STATUSES.has(p.status)) {
              openProposal = p;
              break;
            }
          } catch {
            continue;
          }
        }
        if (openProposal) {
          await deps.sendSms({
            to: ctx.fromE164,
            body: composeBookingStatusReply(businessName),
          });
          await audit(ctx, 'booking_status_sent', {
            voiceSessionId: row.voiceSessionId,
            proposalId: openProposal.id,
          });
          return { handled: true, handler: 'dropped-call-resume' };
        }
      }

      // Bucket 2 — mid-intent / early / resolved proposal: schedule a human
      // callback and acknowledge.
      let callMeBackTaskId: string | undefined;
      if (deps.callMeBackRepo) {
        try {
          const task = await deps.callMeBackRepo.create({
            tenantId: ctx.tenantId,
            sessionId: row.voiceSessionId,
            callerPhone: ctx.fromE164,
            callbackMessage: ctx.body.slice(0, 300),
            ...(row.context?.intent ? { intentSummary: row.context.intent } : {}),
            reason: 'dropped_call_resume',
            scheduledFor: now(),
          });
          callMeBackTaskId = task.id;
        } catch (err) {
          deps.logger?.warn('dropped-call resume: call_me_back create failed', {
            tenantId: ctx.tenantId,
            voiceSessionId: row.voiceSessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      await deps.sendSms({
        to: ctx.fromE164,
        body: composeCallbackReply(businessName),
      });
      await audit(ctx, 'callback_scheduled', {
        voiceSessionId: row.voiceSessionId,
        callMeBackTaskId: callMeBackTaskId ?? null,
        bucket: row.context?.bucket ?? null,
      });
      return { handled: true, handler: 'dropped-call-resume' };
    },
  };
}
