/**
 * P2-034 — inbound SMS approval transport.
 *
 * The owner replies to a proposal SMS from the truck:
 *
 *   Y / YES / OK / APPROVE → approve through the EXISTING approval path
 *     (`approveProposal`) — execution, undo window, audits all behave
 *     exactly as a dashboard approval. No executor bypass.
 *   N / NO / REJECT [reason…] → reject; trailing text is the reason.
 *   EDIT / CHANGE → opens a 10-minute edit session; the NEXT message is
 *     the requested change (handled by the fallback handler below).
 *   anything else (fallback) → one clarification nudge per proposal, then
 *     escalate to the review queue via audit — never a reply loop.
 *
 * Trust model: identity is the inbound mobile number, verified against
 * `tenant_settings.owner_phone` (and the backup supervisor's mobile) with
 * the same normalization as voice activation. The body is never trusted
 * for identity. Tenant isolation is structural — the Twilio webhook URL
 * binds the tenant, signature-verified upstream, and every repo call is
 * tenant-scoped (RLS underneath).
 *
 * Idempotency: duplicate webhook deliveries are dropped upstream on
 * (source='twilio', MessageSid). A *re-sent* approval (new MessageSid,
 * same intent) lands on `approveProposal`'s status guard and produces a
 * truthful "already handled" reply instead of a double execution.
 *
 * Handlers NEVER throw — the dispatcher contract requires a structured
 * result (a throw would make Twilio retry an acknowledged delivery).
 */
import {
  parseProposalSmsReply,
  APPROVE_TOKENS,
  REJECT_TOKENS,
  EDIT_TOKENS,
} from '@ai-service-os/shared';
import type {
  InboundSmsContext,
  HandlerResult,
  KeywordHandler,
  FallbackHandler,
} from '../../sms/inbound-dispatch';
import type { Proposal, ProposalRepository } from '../proposal';
import { approveProposal, rejectProposal, editProposal } from '../actions';
import type { SettingsRepository } from '../../settings/settings';
import type { AppointmentRepository } from '../../appointments/appointment';
import type { UserRepository } from '../../users/user';
import { type AuditRepository, createAuditEvent } from '../../audit/audit';
import { ValidationError } from '../../shared/errors';
import { normalizePhone } from '../../shared/phone';
import { STOP_KEYWORDS, START_KEYWORDS } from '../../compliance/stop-reply';
import {
  type ProposalSmsEventRepository,
  createProposalSmsEvent,
} from './sms-event';
import { renderProposalSms } from './render';

/** Synthetic actor for SMS reply approvals (no Clerk session). */
export const SMS_REPLY_ACTOR_ID = 'sms_reply';

/** Edit session window. Fixed from open — never extended by later messages. */
export const EDIT_SESSION_TTL_MS = 10 * 60 * 1000;

/** One clarification nudge per proposal, then escalate silently. */
const CLARIFICATION_LIMIT = 1;

const HANDLER_NAME = 'proposal-reply';

export interface ProposalSmsReplyDeps {
  proposalRepo: ProposalRepository;
  smsEventRepo: ProposalSmsEventRepository;
  settingsRepo: SettingsRepository;
  /** Resolves the backup supervisor's mobile. Optional — owner_phone still works. */
  userRepo?: UserRepository;
  auditRepo?: AuditRepository;
  /** Outbound reply seam. Absent (dev without Twilio): actions still apply, replies are skipped. */
  sendSms?: (to: string, body: string) => Promise<void>;
  /** Lets a rejected create_booking release its held calendar slot. */
  appointmentRepo?: AppointmentRepository;
  /**
   * LLM seam: turn a free-text instruction into a payload delta for
   * `editProposal` (which Zod-validates the result — a bad delta can
   * never corrupt a proposal). Absent or returning null: the change is
   * recorded as an `edit_request` event + audit and the owner is told,
   * truthfully, to finish it in the review queue.
   */
  interpretEdit?: (args: {
    proposal: Proposal;
    instruction: string;
  }) => Promise<Record<string, unknown> | null>;
  now?: () => Date;
}

async function resolveApproverPhones(
  deps: ProposalSmsReplyDeps,
  tenantId: string,
): Promise<string[]> {
  const settings = await deps.settingsRepo.findByTenant(tenantId);
  const phones: string[] = [];
  if (settings?.ownerPhone) phones.push(settings.ownerPhone);
  if (settings?.backupSupervisorUserId && deps.userRepo) {
    const backup = await deps.userRepo.findById(tenantId, settings.backupSupervisorUserId);
    if (backup?.mobileNumber) phones.push(backup.mobileNumber);
  }
  return phones;
}

function isApprover(phones: string[], fromE164: string): boolean {
  const from = normalizePhone(fromE164);
  if (!from) return false;
  return phones.some((p) => normalizePhone(p) === from);
}

async function audit(
  deps: ProposalSmsReplyDeps,
  ctx: InboundSmsContext,
  eventType: string,
  proposalId: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  if (!deps.auditRepo) return;
  await deps.auditRepo.create(
    createAuditEvent({
      tenantId: ctx.tenantId,
      actorId: SMS_REPLY_ACTOR_ID,
      actorRole: 'system',
      eventType,
      entityType: 'proposal',
      entityId: proposalId || ctx.messageSid,
      metadata: {
        ...metadata,
        channel: 'sms_reply',
        messageSid: ctx.messageSid,
        fromE164: ctx.fromE164,
        // The body lives in proposal_sms_events (RLS-scoped); audit logs
        // carry only its length to keep PII out of log pipelines.
        bodyLength: ctx.body.length,
      },
    }),
  );
}

function isReviewable(proposal: Proposal): boolean {
  return proposal.status === 'ready_for_review' || proposal.status === 'draft';
}

type TargetResolution =
  | { kind: 'none' }
  | { kind: 'already_handled'; proposal: Proposal }
  | { kind: 'reviewable'; proposal: Proposal };

/**
 * Resolve which proposal an inbound reply targets: the most recent
 * outbound render, and ONLY that one. An SMS reply carries no proposal
 * identifier, so the latest message we sent is the only thing the owner
 * can be answering. If that proposal was meanwhile handled (dashboard
 * approval, a re-sent Y), the reply must NOT fall through to an older
 * pending proposal — a `Y` meant for one piece of work could silently
 * approve another. Stale target → truthful "already handled" instead.
 */
/**
 * The open edit session, IF it is still the sender's live conversation.
 * Sender-scoped: a tenant can have two approvers (owner + backup), and
 * one approver's session must never capture the other's Y/N. And when a
 * newer proposal SMS went out after the session opened, replies now
 * belong to that newer message — a `Y` meant for the new proposal must
 * not be swallowed as edit text for the old one. A superseded session is
 * consumed (audited) and the reply falls through to normal targeting.
 */
async function findActiveEditSession(
  deps: ProposalSmsReplyDeps,
  ctx: InboundSmsContext,
): Promise<{ id: string; proposalId: string } | null> {
  const now = deps.now ? deps.now() : new Date();
  const session = await deps.smsEventRepo.findOpenEditSession(
    ctx.tenantId,
    normalizePhone(ctx.fromE164),
    now,
  );
  if (!session) return null;
  const [latest] = await deps.smsEventRepo.findRecentOutbound(ctx.tenantId, 1);
  if (latest && latest.createdAt.getTime() > session.createdAt.getTime()) {
    await deps.smsEventRepo.markConsumed(ctx.tenantId, session.id, now);
    await audit(deps, ctx, 'proposal.sms_edit_session_superseded', session.proposalId, {
      supersededByProposalId: latest.proposalId,
    });
    return null;
  }
  return session;
}

async function resolveTargetProposal(
  deps: ProposalSmsReplyDeps,
  tenantId: string,
): Promise<TargetResolution> {
  const [latest] = await deps.smsEventRepo.findRecentOutbound(tenantId, 1);
  if (!latest) return { kind: 'none' };
  const proposal = await deps.proposalRepo.findById(tenantId, latest.proposalId);
  if (!proposal) return { kind: 'none' };
  return isReviewable(proposal)
    ? { kind: 'reviewable', proposal }
    : { kind: 'already_handled', proposal };
}

async function reply(
  deps: ProposalSmsReplyDeps,
  to: string,
  body: string,
): Promise<void> {
  if (!deps.sendSms) return;
  await deps.sendSms(to, body);
}

async function recordInbound(
  deps: ProposalSmsReplyDeps,
  ctx: InboundSmsContext,
  proposalId: string,
  kind: 'reply_approve' | 'reply_reject' | 'edit_session_opened' | 'edit_request',
  expiresAt?: Date,
): Promise<void> {
  await deps.smsEventRepo.create(
    createProposalSmsEvent({
      tenantId: ctx.tenantId,
      proposalId,
      direction: 'inbound',
      kind,
      messageSid: ctx.messageSid,
      fromPhone: normalizePhone(ctx.fromE164),
      body: ctx.body,
      ...(expiresAt ? { expiresAt } : {}),
      ...(deps.now ? { now: deps.now() } : {}),
    }),
  );
}

async function handleApprove(
  deps: ProposalSmsReplyDeps,
  ctx: InboundSmsContext,
  proposal: Proposal,
): Promise<HandlerResult> {
  await recordInbound(deps, ctx, proposal.id, 'reply_approve');

  // A recorded-but-unapplied edit request means the owner asked for a
  // change that needs the review queue — approving now would execute the
  // stale payload they were told required manual handling. (A successful
  // SMS edit re-renders and unblocks; rejecting stays allowed.)
  if (await deps.smsEventRepo.hasUnappliedEditRequest(ctx.tenantId, proposal.id)) {
    await audit(deps, ctx, 'proposal.sms_approve_blocked_pending_edit', proposal.id, {});
    await reply(
      deps,
      ctx.fromE164,
      'You asked to change this one — your note is attached. Review and approve it in your queue.',
    );
    return { handled: true, handler: HANDLER_NAME, reason: 'approve_blocked_pending_edit' };
  }

  try {
    const approved = await approveProposal(
      deps.proposalRepo,
      ctx.tenantId,
      proposal.id,
      SMS_REPLY_ACTOR_ID,
      'owner',
      deps.auditRepo,
    );
    await audit(deps, ctx, 'proposal.sms_approved', proposal.id, {
      proposalType: proposal.proposalType,
    });
    await reply(deps, ctx.fromE164, `Approved — "${approved.summary}" will run shortly.`);
    return { handled: true, handler: HANDLER_NAME, reason: 'approved' };
  } catch (err) {
    if (err instanceof ValidationError) {
      // Missing required fields — truthful, with the next step.
      await audit(deps, ctx, 'proposal.sms_approve_blocked', proposal.id, {
        error: err.message,
      });
      await reply(
        deps,
        ctx.fromE164,
        `Can't approve yet — it's missing required info. Open your review queue to finish it.`,
      );
      return { handled: true, handler: HANDLER_NAME, reason: 'approve_blocked' };
    }
    await audit(deps, ctx, 'proposal.sms_approve_failed', proposal.id, {
      error: err instanceof Error ? err.message : String(err),
    });
    await reply(
      deps,
      ctx.fromE164,
      'Couldn’t approve that — it may already be handled. Check your review queue.',
    );
    return { handled: true, handler: HANDLER_NAME, reason: 'approve_failed' };
  }
}

async function handleReject(
  deps: ProposalSmsReplyDeps,
  ctx: InboundSmsContext,
  proposal: Proposal,
  reason: string,
): Promise<HandlerResult> {
  await recordInbound(deps, ctx, proposal.id, 'reply_reject');
  try {
    const rejected = await rejectProposal(
      deps.proposalRepo,
      ctx.tenantId,
      proposal.id,
      SMS_REPLY_ACTOR_ID,
      'owner',
      reason || 'Rejected via SMS reply',
      undefined,
      deps.appointmentRepo,
      deps.auditRepo,
    );
    await audit(deps, ctx, 'proposal.sms_rejected', proposal.id, {
      proposalType: proposal.proposalType,
    });
    await reply(deps, ctx.fromE164, `Rejected — "${rejected.summary}" won't run.`);
    return { handled: true, handler: HANDLER_NAME, reason: 'rejected' };
  } catch (err) {
    await audit(deps, ctx, 'proposal.sms_reject_failed', proposal.id, {
      error: err instanceof Error ? err.message : String(err),
    });
    await reply(
      deps,
      ctx.fromE164,
      'Couldn’t reject that — it may already be handled. Check your review queue.',
    );
    return { handled: true, handler: HANDLER_NAME, reason: 'reject_failed' };
  }
}

async function handleEditOpen(
  deps: ProposalSmsReplyDeps,
  ctx: InboundSmsContext,
  proposal: Proposal,
): Promise<HandlerResult> {
  const now = deps.now ? deps.now() : new Date();
  await recordInbound(
    deps,
    ctx,
    proposal.id,
    'edit_session_opened',
    new Date(now.getTime() + EDIT_SESSION_TTL_MS),
  );
  await audit(deps, ctx, 'proposal.sms_edit_session_opened', proposal.id, {
    proposalType: proposal.proposalType,
  });
  await reply(
    deps,
    ctx.fromE164,
    'What should I change? Reply with the change in one message (within 10 minutes).',
  );
  return { handled: true, handler: HANDLER_NAME, reason: 'edit_session_opened' };
}

export async function handleProposalSmsReply(
  ctx: InboundSmsContext,
  deps: ProposalSmsReplyDeps,
): Promise<HandlerResult> {
  const parsed = parseProposalSmsReply(ctx.body);
  if (parsed.intent === 'unrecognized') {
    // Defensive — the dispatcher only routes registered tokens here.
    return { handled: false, handler: HANDLER_NAME, reason: 'unrecognized_keyword' };
  }

  const phones = await resolveApproverPhones(deps, ctx.tenantId);
  if (!isApprover(phones, ctx.fromE164)) {
    await audit(deps, ctx, 'proposal.sms_reply_unverified_mobile', '', {
      intent: parsed.intent,
    });
    return { handled: false, handler: HANDLER_NAME, reason: 'unknown_mobile' };
  }

  // An open edit session captures EVERYTHING the owner sends next — the
  // instruction often starts with a registered token ("change the price
  // to $200", "fix the date"), which routes here instead of the fallback.
  // Without this, such a message would re-open a session and ask "What
  // should I change?" forever.
  const session = await findActiveEditSession(deps, ctx);
  if (session) {
    return handleEditRequest(deps, ctx, session.id, session.proposalId);
  }

  const target = await resolveTargetProposal(deps, ctx.tenantId);
  if (target.kind === 'none') {
    await audit(deps, ctx, 'proposal.sms_reply_no_pending', '', {
      intent: parsed.intent,
    });
    await reply(
      deps,
      ctx.fromE164,
      'Nothing is waiting for your approval right now.',
    );
    return { handled: true, handler: HANDLER_NAME, reason: 'no_pending_proposal' };
  }
  if (target.kind === 'already_handled') {
    await audit(deps, ctx, 'proposal.sms_reply_stale_target', target.proposal.id, {
      intent: parsed.intent,
      proposalStatus: target.proposal.status,
    });
    await reply(
      deps,
      ctx.fromE164,
      `"${target.proposal.summary}" was already handled — this didn't change anything. Check your review queue for anything else waiting.`,
    );
    return { handled: true, handler: HANDLER_NAME, reason: 'already_handled' };
  }
  const proposal = target.proposal;

  switch (parsed.intent) {
    case 'approve':
      return handleApprove(deps, ctx, proposal);
    case 'reject':
      return handleReject(deps, ctx, proposal, parsed.remainder);
    case 'edit':
      // "EDIT make it $200" carries the instruction inline — apply it
      // directly instead of a pointless "What should I change?" round trip.
      if (parsed.remainder) {
        return applyEditInstruction(deps, ctx, proposal, ctx.body);
      }
      return handleEditOpen(deps, ctx, proposal);
    default:
      return { handled: false, handler: HANDLER_NAME, reason: 'unrecognized_keyword' };
  }
}

/**
 * Tokens the compliance STOP/START handlers own (TCPA). `yes` doubles as
 * the opt-in keyword — it reaches this feature only through the composite
 * in start-keyword.ts, never by direct registration. Kept in sync with
 * compliance/stop-reply.ts via the registration test.
 */
export const COMPLIANCE_RESERVED_TOKENS: ReadonlySet<string> = new Set([
  ...STOP_KEYWORDS,
  ...START_KEYWORDS,
].map((k) => k.toLowerCase()));

export class ProposalReplyKeywordHandler implements KeywordHandler {
  readonly keywords: readonly string[] = [
    ...APPROVE_TOKENS,
    ...REJECT_TOKENS,
    ...EDIT_TOKENS,
  ].filter((k) => !COMPLIANCE_RESERVED_TOKENS.has(k));

  constructor(private readonly deps: ProposalSmsReplyDeps) {}

  async handle(ctx: InboundSmsContext): Promise<HandlerResult> {
    try {
      return await handleProposalSmsReply(ctx, this.deps);
    } catch (err) {
      return {
        handled: false,
        handler: HANDLER_NAME,
        reason: err instanceof Error ? err.message : 'handler_error',
      };
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Fallback — free-text from the owner: edit-session capture, or the
// one-time clarification nudge when a proposal is awaiting a reply.
// ───────────────────────────────────────────────────────────────────────────

async function handleEditRequest(
  deps: ProposalSmsReplyDeps,
  ctx: InboundSmsContext,
  sessionId: string,
  proposalId: string,
): Promise<HandlerResult> {
  const now = deps.now ? deps.now() : new Date();
  const proposal = await deps.proposalRepo.findById(ctx.tenantId, proposalId);

  // Whatever happens next, this message consumes the session — a second
  // message starts over with EDIT, which also bounds LLM spend per session.
  await deps.smsEventRepo.markConsumed(ctx.tenantId, sessionId, now);

  if (!proposal || !isReviewable(proposal)) {
    await audit(deps, ctx, 'proposal.sms_edit_target_gone', proposalId, {});
    await reply(
      deps,
      ctx.fromE164,
      'That proposal was already handled, so I didn’t change anything.',
    );
    return { handled: true, handler: HANDLER_NAME, reason: 'edit_target_gone' };
  }

  return applyEditInstruction(deps, ctx, proposal, ctx.body);
}

/**
 * Apply a free-text edit instruction to a reviewable proposal. Shared by
 * the open-session capture (instruction is the whole next message) and
 * the inline "EDIT make it $200" form.
 */
async function applyEditInstruction(
  deps: ProposalSmsReplyDeps,
  ctx: InboundSmsContext,
  proposal: Proposal,
  instruction: string,
): Promise<HandlerResult> {
  const now = deps.now ? deps.now() : new Date();
  await recordInbound(deps, ctx, proposal.id, 'edit_request');

  if (deps.interpretEdit) {
    try {
      const edits = await deps.interpretEdit({ proposal, instruction });
      if (edits && Object.keys(edits).length > 0) {
        // editProposal Zod-validates the merged payload — a hallucinated
        // delta fails closed into the manual-review path below.
        const { proposal: updated, editedFields } = await editProposal(
          deps.proposalRepo,
          ctx.tenantId,
          proposal.id,
          SMS_REPLY_ACTOR_ID,
          'owner',
          edits,
          deps.auditRepo,
        );
        // The stored summary was written BEFORE the edit, so it can still
        // describe the old value (a time, a price). The owner must never
        // re-approve text that contradicts what will execute — echo their
        // own instruction so the change is explicit. Money/customer facts
        // are appended from the NEW payload by the renderer.
        const instructionNote =
          instruction.trim().length > 80
            ? `${instruction.trim().slice(0, 79)}…`
            : instruction.trim();
        // Pre-truncate the base summary: the renderer trims the summary
        // tail to fit, and the change note must survive that trim.
        const baseSummary =
          updated.summary.length > 140
            ? `${updated.summary.slice(0, 139)}…`
            : updated.summary;
        const body = renderProposalSms(
          {
            proposalType: updated.proposalType,
            summary: `${baseSummary} — your change: "${instructionNote}"`,
            payload: updated.payload,
          },
          { reapproval: true },
        );
        await deps.smsEventRepo.create(
          createProposalSmsEvent({
            tenantId: ctx.tenantId,
            proposalId: updated.id,
            direction: 'outbound',
            kind: 'reapproval_rendered',
            body,
            now,
          }),
        );
        await audit(deps, ctx, 'proposal.sms_edited', updated.id, { editedFields });
        await reply(deps, ctx.fromE164, body);
        return { handled: true, handler: HANDLER_NAME, reason: 'edited' };
      }
    } catch (err) {
      await audit(deps, ctx, 'proposal.sms_edit_failed', proposal.id, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // No interpreter, an empty delta, or a failed/invalid one: the request
  // is recorded (edit_request event + audit) and the owner gets the
  // truthful next step — never a silent guess.
  await audit(deps, ctx, 'proposal.sms_edit_requested', proposal.id, {});
  await reply(
    deps,
    ctx.fromE164,
    'Got it — I couldn’t apply that automatically, so I attached your note to the proposal. Finish it in your review queue.',
  );
  return { handled: true, handler: HANDLER_NAME, reason: 'edit_recorded' };
}

export async function handleProposalSmsFallback(
  ctx: InboundSmsContext,
  deps: ProposalSmsReplyDeps,
): Promise<HandlerResult> {
  const phones = await resolveApproverPhones(deps, ctx.tenantId);
  if (!isApprover(phones, ctx.fromE164)) {
    // Not the owner — silently decline so other features (and the
    // unhandled audit upstream) keep their behavior.
    return { handled: false, handler: HANDLER_NAME, reason: 'not_owner' };
  }

  const session = await findActiveEditSession(deps, ctx);
  if (session) {
    return handleEditRequest(deps, ctx, session.id, session.proposalId);
  }

  // Only nudge while the latest render is still actionable — clarifying
  // about an already-handled proposal would just confuse the owner.
  const target = await resolveTargetProposal(deps, ctx.tenantId);
  if (target.kind !== 'reviewable') {
    return { handled: false, handler: HANDLER_NAME, reason: 'no_context' };
  }
  const proposal = target.proposal;

  const nudges = await deps.smsEventRepo.countClarifications(ctx.tenantId, proposal.id);
  if (nudges >= CLARIFICATION_LIMIT) {
    // Asked once already — escalate to the review queue instead of looping.
    await audit(deps, ctx, 'proposal.sms_clarification_escalated', proposal.id, {});
    return { handled: true, handler: HANDLER_NAME, reason: 'clarification_escalated' };
  }

  const body = 'Didn’t catch that. Reply Y to approve, N to reject, or EDIT to change it.';
  await deps.smsEventRepo.create(
    createProposalSmsEvent({
      tenantId: ctx.tenantId,
      proposalId: proposal.id,
      direction: 'outbound',
      kind: 'clarification_sent',
      body,
      now: deps.now ? deps.now() : new Date(),
    }),
  );
  await audit(deps, ctx, 'proposal.sms_clarification_sent', proposal.id, {});
  await reply(deps, ctx.fromE164, body);
  return { handled: true, handler: HANDLER_NAME, reason: 'clarification_sent' };
}

export class ProposalReplyFallbackHandler implements FallbackHandler {
  readonly name = HANDLER_NAME;

  constructor(private readonly deps: ProposalSmsReplyDeps) {}

  async handle(ctx: InboundSmsContext): Promise<HandlerResult> {
    try {
      return await handleProposalSmsFallback(ctx, this.deps);
    } catch (err) {
      return {
        handled: false,
        handler: HANDLER_NAME,
        reason: err instanceof Error ? err.message : 'handler_error',
      };
    }
  }
}
