/**
 * P2-034 — SMS one-tap proposal approval: inbound handler.
 *
 * Routed here by the keyword dispatcher when an owner replies
 * APPROVE/YES/REJECT/NO (optionally with a code). Resolves the sender,
 * picks the proposal, and drives the existing proposal lifecycle
 * (approveProposal / rejectProposal) — SMS is just a transport, every
 * audit + RBAC guarantee is reused unchanged.
 *
 * NEVER throws — the inbound dispatcher contract requires a structured
 * HandlerResult (a throw makes Twilio retry an already-acknowledged
 * delivery, re-firing side effects). Inbound idempotency is handled one
 * layer up: the webhook dedupes on MessageSid before we run.
 */
import {
  KeywordHandler,
  InboundSmsContext,
  HandlerResult,
} from '../inbound-dispatch';
import { UserRepository } from '../../users/user';
import {
  Proposal,
  ProposalRepository,
} from '../../proposals/proposal';
import { approveProposal, rejectProposal } from '../../proposals/actions';
import { AppointmentRepository } from '../../appointments/appointment';
import { AuditRepository, createAuditEvent } from '../../audit/audit';
import { hasPermission } from '../../auth/rbac';
import { ValidationError } from '../../shared/errors';
import { MessageDeliveryProvider } from '../../notifications/delivery-provider';
import { createLogger } from '../../logging/logger';
import {
  PROPOSAL_APPROVAL_KEYWORDS,
  parseApprovalReply,
  renderApprovalReplySms,
  smsApprovalCodeOf,
  ReplyOutcome,
} from './render';

const logger = createLogger({
  service: 'sms-proposal-approval',
  environment: process.env.NODE_ENV || 'dev',
});

export interface ProposalApprovalHandlerDeps {
  userRepo: UserRepository;
  proposalRepo: ProposalRepository;
  /** Used to text the owner back a confirmation. */
  messageDelivery: MessageDeliveryProvider;
  /** Releases a held slot when a create_booking is rejected. Optional. */
  appointmentRepo?: AppointmentRepository;
  auditRepo?: AuditRepository;
}

async function audit(
  deps: ProposalApprovalHandlerDeps,
  ctx: InboundSmsContext,
  eventType: string,
  entity: { type: string; id: string },
  metadata: Record<string, unknown>,
): Promise<void> {
  if (!deps.auditRepo) return;
  try {
    await deps.auditRepo.create(
      createAuditEvent({
        tenantId: ctx.tenantId,
        actorId: entity.id,
        actorRole: 'owner',
        eventType,
        entityType: entity.type,
        entityId: entity.id,
        metadata: { ...metadata, fromE164: ctx.fromE164, messageSid: ctx.messageSid },
      }),
    );
  } catch (err) {
    // Audit failure must never break the reply path.
    logger.warn('proposal-approval: audit write failed', {
      eventType,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function reply(
  deps: ProposalApprovalHandlerDeps,
  ctx: InboundSmsContext,
  outcome: ReplyOutcome,
  extra: { proposal?: Proposal; pendingCount?: number } = {},
): Promise<void> {
  try {
    await deps.messageDelivery.sendSms({
      to: ctx.fromE164,
      tenantId: ctx.tenantId,
      body: renderApprovalReplySms(outcome, extra),
      // The webhook already dedupes inbound by MessageSid, so one reply
      // per inbound message; key on it so a provider-side retry of the
      // OUTBOUND confirmation also dedupes within ~24h.
      idempotencyKey: `proposal-approval-reply:${ctx.messageSid}`,
    });
  } catch (err) {
    logger.warn('proposal-approval: confirmation send failed', {
      tenantId: ctx.tenantId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Pick the proposal the reply refers to.
 *   - code present → the ready_for_review proposal carrying that code.
 *   - no code, exactly one pending → that one (the common one-tap case).
 *   - no code, several pending → ambiguous; ask for a code.
 *   - none pending → nothing waiting.
 */
type Resolution =
  | { kind: 'target'; proposal: Proposal }
  | { kind: 'needs_code'; pendingCount: number }
  | { kind: 'nothing_pending' }
  | { kind: 'not_found' };

function resolveTarget(pending: Proposal[], code: string | undefined): Resolution {
  if (code) {
    const match = pending.find((p) => smsApprovalCodeOf(p) === code);
    return match ? { kind: 'target', proposal: match } : { kind: 'not_found' };
  }
  if (pending.length === 0) return { kind: 'nothing_pending' };
  if (pending.length === 1) return { kind: 'target', proposal: pending[0] };
  return { kind: 'needs_code', pendingCount: pending.length };
}

export async function handleProposalApprovalSms(
  ctx: InboundSmsContext,
  deps: ProposalApprovalHandlerDeps,
): Promise<HandlerResult> {
  const handler = 'proposal-approval';
  const parsed = parseApprovalReply(ctx.body);
  if (!parsed) {
    // Dispatcher matched a keyword but the body didn't parse — defensive.
    return { handled: false, handler, reason: 'unparseable' };
  }

  // Identity + RBAC. Unknown numbers and non-approvers get NO reply — we
  // never text strangers or turn the line into a bot for techs. The body
  // is never trusted for identity (anti-spoofing), only the verified
  // mobile → user mapping.
  const user = await deps.userRepo.findByMobileNumber(ctx.tenantId, ctx.fromE164);
  if (!user) {
    await audit(deps, ctx, 'proposal_approval.unverified_mobile', {
      type: 'sms_inbound',
      id: ctx.messageSid,
    }, { reason: 'unknown_mobile' });
    return { handled: false, handler, reason: 'unknown_mobile' };
  }
  if (!hasPermission(user.role, 'proposals:approve')) {
    await audit(deps, ctx, 'proposal_approval.forbidden', { type: 'user', id: user.id }, {
      role: user.role,
    });
    return { handled: false, handler, reason: 'forbidden' };
  }

  const pending = await deps.proposalRepo.findByStatus(ctx.tenantId, 'ready_for_review');
  const resolution = resolveTarget(pending, parsed.code);

  if (resolution.kind === 'nothing_pending') {
    await reply(deps, ctx, 'nothing_pending');
    return { handled: true, handler, reason: 'nothing_pending' };
  }
  if (resolution.kind === 'not_found') {
    await reply(deps, ctx, 'not_found');
    return { handled: true, handler, reason: 'not_found' };
  }
  if (resolution.kind === 'needs_code') {
    await reply(deps, ctx, 'needs_code', { pendingCount: resolution.pendingCount });
    return { handled: true, handler, reason: 'needs_code' };
  }

  const proposal = resolution.proposal;

  try {
    if (parsed.action === 'approve') {
      await approveProposal(
        deps.proposalRepo,
        ctx.tenantId,
        proposal.id,
        user.id,
        user.role,
        deps.auditRepo,
      );
      await audit(deps, ctx, 'proposal_approval.sms_approved', { type: 'proposal', id: proposal.id }, {
        proposalType: proposal.proposalType,
      });
      await reply(deps, ctx, 'approved', { proposal });
      return { handled: true, handler, reason: 'approved' };
    }

    await rejectProposal(
      deps.proposalRepo,
      ctx.tenantId,
      proposal.id,
      user.id,
      user.role,
      'sms_rejected',
      undefined,
      deps.appointmentRepo,
      deps.auditRepo,
    );
    await audit(deps, ctx, 'proposal_approval.sms_rejected', { type: 'proposal', id: proposal.id }, {
      proposalType: proposal.proposalType,
    });
    await reply(deps, ctx, 'rejected', { proposal });
    return { handled: true, handler, reason: 'rejected' };
  } catch (err) {
    // A proposal with unfilled required fields can't be approved over SMS
    // (it needs the app to fill the gaps). Other failures are surfaced as
    // a generic "not found" so the owner isn't left wondering.
    if (err instanceof ValidationError) {
      await audit(deps, ctx, 'proposal_approval.needs_details', { type: 'proposal', id: proposal.id }, {
        proposalType: proposal.proposalType,
      });
      await reply(deps, ctx, 'needs_details', { proposal });
      return { handled: true, handler, reason: 'needs_details' };
    }
    logger.error('proposal-approval: lifecycle action failed', {
      tenantId: ctx.tenantId,
      proposalId: proposal.id,
      action: parsed.action,
      error: err instanceof Error ? err.message : String(err),
    });
    await reply(deps, ctx, 'not_found');
    return { handled: false, handler, reason: 'action_failed' };
  }
}

/**
 * The P2-034 KeywordHandler for proposal approval. Registers
 * APPROVE/YES/OK/Y/REJECT/NO/DECLINE/N and delegates to
 * `handleProposalApprovalSms`.
 */
export class ProposalApprovalKeywordHandler implements KeywordHandler {
  readonly keywords: readonly string[] = PROPOSAL_APPROVAL_KEYWORDS;

  constructor(private readonly deps: ProposalApprovalHandlerDeps) {}

  async handle(ctx: InboundSmsContext): Promise<HandlerResult> {
    return handleProposalApprovalSms(ctx, this.deps);
  }
}

export function buildProposalApprovalKeywordHandler(
  deps: ProposalApprovalHandlerDeps,
): ProposalApprovalKeywordHandler {
  return new ProposalApprovalKeywordHandler(deps);
}
