import {
  ALL_PROPOSAL_SMS_KEYWORDS,
  type ProposalSmsEventRecord,
} from '@ai-service-os/shared';
import {
  InboundSmsContext,
  HandlerResult,
} from '../inbound-dispatch';
import { UserRepository } from '../../users/user';
import { ProposalRepository } from '../../proposals/proposal';
import { AuditRepository, createAuditEvent } from '../../audit/audit';
import { approveProposal, rejectProposal } from '../../proposals/actions';
import { parseInboundProposalSms } from '../../proposals/sms/parse-inbound';
import { renderProposalSms } from '../../proposals/sms/render';
import {
  ProposalSmsEventRepository,
  RecordProposalSmsEventInput,
} from './repository';

const EDIT_SESSION_MS = 10 * 60 * 1000;

export interface ProposalApprovalHandlerDeps {
  userRepo: UserRepository;
  proposalRepo: ProposalRepository;
  smsEventRepo: ProposalSmsEventRepository;
  auditRepo?: AuditRepository;
  sendSms?: (to: string, body: string) => Promise<void>;
  now?: () => Date;
}

async function audit(
  deps: ProposalApprovalHandlerDeps,
  ctx: InboundSmsContext,
  eventType: string,
  proposalId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  if (!deps.auditRepo) return;
  await deps.auditRepo.create(
    createAuditEvent({
      tenantId: ctx.tenantId,
      actorId: metadata.ownerUserId ? String(metadata.ownerUserId) : 'system',
      actorRole: 'owner',
      eventType,
      entityType: 'proposal',
      entityId: proposalId,
      metadata: {
        ...metadata,
        messageSid: ctx.messageSid,
        fromE164: ctx.fromE164,
      },
    }),
  );
}

async function resolveTargetProposalId(
  deps: ProposalApprovalHandlerDeps,
  ctx: InboundSmsContext,
  ownerUserId: string,
): Promise<string | null> {
  const now = (deps.now ?? (() => new Date()))();
  const session = await deps.smsEventRepo.findActiveEditSession(
    ctx.tenantId,
    ownerUserId,
    now,
  );
  if (session) return session.proposalId;

  const latestOutbound = await deps.smsEventRepo.findLatestOutboundForPhone(
    ctx.tenantId,
    ctx.fromE164,
  );
  if (latestOutbound) return latestOutbound.proposalId;

  const [ready, drafts] = await Promise.all([
    deps.proposalRepo.findByStatus(ctx.tenantId, 'ready_for_review'),
    deps.proposalRepo.findByStatus(ctx.tenantId, 'draft'),
  ]);
  const pending = [...ready, ...drafts].sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
  );
  return pending[0]?.id ?? null;
}

export async function recordOutboundProposalSms(
  deps: ProposalApprovalHandlerDeps,
  input: Omit<RecordProposalSmsEventInput, 'direction' | 'inboundAction'>,
): Promise<boolean> {
  return deps.smsEventRepo.recordEvent({
    ...input,
    direction: 'outbound',
  });
}

export async function handleProposalApprovalSms(
  ctx: InboundSmsContext,
  deps: ProposalApprovalHandlerDeps,
): Promise<HandlerResult> {
  const now = (deps.now ?? (() => new Date()))();

  const existing = await deps.smsEventRepo.findByMessageSid(ctx.messageSid);
  if (existing) {
    return { handled: true, handler: 'proposal-approval', reason: 'duplicate_message_sid' };
  }

  const user = await deps.userRepo.findByMobileNumber(ctx.tenantId, ctx.fromE164);
  if (!user || user.role !== 'owner') {
    await audit(deps, ctx, 'proposal_sms.unverified_mobile', '', {
      reason: user ? 'not_owner' : 'unknown_mobile',
      resolvedRole: user?.role ?? null,
    });
    return { handled: false, handler: 'proposal-approval', reason: 'unknown_mobile' };
  }

  const activeEdit = await deps.smsEventRepo.findActiveEditSession(
    ctx.tenantId,
    user.id,
    now,
  );
  if (activeEdit) {
    return handleEditDelta(ctx, deps, user.id, activeEdit.proposalId, now);
  }

  const parsed = parseInboundProposalSms(ctx.body);
  if (parsed.action === 'unknown') {
    if (deps.sendSms) {
      await deps.sendSms(
        ctx.fromE164,
        'Reply APPROVE, EDIT, or REJECT to act on your latest proposal.',
      );
    }
    return { handled: true, handler: 'proposal-approval', reason: 'clarification_sent' };
  }

  const proposalId = await resolveTargetProposalId(deps, ctx, user.id);
  if (!proposalId) {
    return { handled: false, handler: 'proposal-approval', reason: 'no_pending_proposal' };
  }

  const proposal = await deps.proposalRepo.findById(ctx.tenantId, proposalId);
  if (!proposal) {
    return { handled: false, handler: 'proposal-approval', reason: 'proposal_not_found' };
  }

  await deps.smsEventRepo.recordEvent({
    tenantId: ctx.tenantId,
    proposalId,
    direction: 'inbound',
    messageSid: ctx.messageSid,
    ownerE164: ctx.fromE164,
    bodyPreview: ctx.body,
    inboundAction: parsed.action,
  });

  if (parsed.action === 'approve') {
    try {
      await approveProposal(
        deps.proposalRepo,
        ctx.tenantId,
        proposalId,
        user.id,
        user.role,
        deps.auditRepo,
      );
      await audit(deps, ctx, 'proposal_sms.approved', proposalId, {
        ownerUserId: user.id,
        action: 'approve',
      });
      if (deps.sendSms) {
        await deps.sendSms(ctx.fromE164, 'Approved. Changes will apply shortly.');
      }
      return { handled: true, handler: 'proposal-approval', reason: 'approved' };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await audit(deps, ctx, 'proposal_sms.approve_failed', proposalId, {
        ownerUserId: user.id,
        reason,
      });
      if (deps.sendSms) {
        await deps.sendSms(ctx.fromE164, `Could not approve: ${reason.slice(0, 80)}`);
      }
      return { handled: true, handler: 'proposal-approval', reason: 'approve_failed' };
    }
  }

  if (parsed.action === 'reject') {
    const reason = parsed.remainder || 'Rejected via SMS';
    await rejectProposal(
      deps.proposalRepo,
      ctx.tenantId,
      proposalId,
      user.id,
      user.role,
      reason,
      undefined,
      undefined,
      deps.auditRepo,
    );
    await audit(deps, ctx, 'proposal_sms.rejected', proposalId, {
      ownerUserId: user.id,
      action: 'reject',
    });
    if (deps.sendSms) {
      await deps.sendSms(ctx.fromE164, 'Rejected.');
    }
    return { handled: true, handler: 'proposal-approval', reason: 'rejected' };
  }

  const expiresAt = new Date(now.getTime() + EDIT_SESSION_MS);
  await deps.smsEventRepo.openEditSession(
    ctx.tenantId,
    proposalId,
    user.id,
    expiresAt,
  );
  await audit(deps, ctx, 'proposal_sms.edit_session_opened', proposalId, {
    ownerUserId: user.id,
    expiresAt: expiresAt.toISOString(),
  });
  if (deps.sendSms) {
    await deps.sendSms(ctx.fromE164, 'What should I change? Reply with your edit.');
  }
  return { handled: true, handler: 'proposal-approval', reason: 'edit_session_opened' };
}

async function handleEditDelta(
  ctx: InboundSmsContext,
  deps: ProposalApprovalHandlerDeps,
  ownerUserId: string,
  proposalId: string,
  now: Date,
): Promise<HandlerResult> {
  const delta = ctx.body.trim();
  if (!delta) {
    return { handled: true, handler: 'proposal-approval', reason: 'empty_edit_delta' };
  }

  await deps.smsEventRepo.recordEvent({
    tenantId: ctx.tenantId,
    proposalId,
    direction: 'inbound',
    messageSid: ctx.messageSid,
    ownerE164: ctx.fromE164,
    bodyPreview: ctx.body,
    inboundAction: 'edit_delta',
  });

  const proposal = await deps.proposalRepo.findById(ctx.tenantId, proposalId);
  if (!proposal) {
    await deps.smsEventRepo.clearEditSession(ctx.tenantId, ownerUserId);
    return { handled: false, handler: 'proposal-approval', reason: 'proposal_not_found' };
  }

  const user = await deps.userRepo.findByMobileNumber(ctx.tenantId, ctx.fromE164);
  if (!user) {
    return { handled: false, handler: 'proposal-approval', reason: 'unknown_mobile' };
  }

  const updatedSummary = `${proposal.summary} (edited: ${delta})`.slice(0, 500);
  const updated = await deps.proposalRepo.update(ctx.tenantId, proposalId, {
    summary: updatedSummary,
    sourceContext: {
      ...(proposal.sourceContext ?? {}),
      ownerSmsEditNote: delta,
    },
  });
  if (!updated) {
    await deps.smsEventRepo.clearEditSession(ctx.tenantId, ownerUserId);
    return { handled: false, handler: 'proposal-approval', reason: 'proposal_not_found' };
  }
  if (deps.auditRepo) {
    await deps.auditRepo.create(
      createAuditEvent({
        tenantId: ctx.tenantId,
        actorId: user.id,
        actorRole: user.role,
        eventType: 'proposal.edited',
        entityType: 'proposal',
        entityId: proposalId,
        metadata: { channel: 'sms', ownerSmsEditNote: delta },
      }),
    );
  }

  await deps.smsEventRepo.clearEditSession(ctx.tenantId, ownerUserId);
  await audit(deps, ctx, 'proposal_sms.edit_applied', proposalId, {
    ownerUserId,
    deltaLength: delta.length,
  });

  const refreshed = await deps.proposalRepo.findById(ctx.tenantId, proposalId);
  if (refreshed && deps.sendSms) {
    const { body } = renderProposalSms(refreshed);
    await deps.sendSms(ctx.fromE164, `Updated. ${body}`);
    await recordOutboundProposalSms(deps, {
      tenantId: ctx.tenantId,
      proposalId,
      messageSid: `outbound-edit-${ctx.messageSid}`,
      ownerE164: ctx.fromE164,
      bodyPreview: body,
    });
  }

  return { handled: true, handler: 'proposal-approval', reason: 'edit_applied' };
}

export const PROPOSAL_APPROVAL_KEYWORDS = ALL_PROPOSAL_SMS_KEYWORDS;

// Re-export for tests that need the record shape.
export type { ProposalSmsEventRecord };
