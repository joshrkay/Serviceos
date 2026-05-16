import { Proposal, ProposalRepository } from './proposal';
import { transitionProposal, isInUndoWindow, UNDO_WINDOW_MS } from './lifecycle';
import { validateProposalPayload } from './contracts';
import { Role, hasPermission } from '../auth/rbac';
import { AppError, ForbiddenError, ValidationError, NotFoundError } from '../shared/errors';
import { AppointmentRepository, updateAppointment } from '../appointments/appointment';
import { AuditRepository, createAuditEvent } from '../audit/audit';
import { logProposalEvent } from './audit';

export async function approveProposal(
  proposalRepo: ProposalRepository,
  tenantId: string,
  proposalId: string,
  actorId: string,
  actorRole: Role,
  auditRepo?: AuditRepository,
): Promise<Proposal> {
  if (!hasPermission(actorRole, 'proposals:approve')) {
    throw new ForbiddenError();
  }

  const proposal = await proposalRepo.findById(tenantId, proposalId);
  if (!proposal) {
    throw new NotFoundError('Proposal', proposalId);
  }

  const transitioned = transitionProposal(proposal, 'approved', actorId);

  // D9 undo window: stamp `approvedAt` on the persisted row so the
  // executor and undoProposal can agree on when the window opened.
  const updated = await proposalRepo.updateStatus(tenantId, proposalId, 'approved', {
    approvedAt: transitioned.approvedAt,
  });
  if (!updated) {
    throw new NotFoundError('Proposal', proposalId);
  }

  // D2-1c — audit-log the approval through the existing helper. The
  // auditRepo arg is optional so legacy call-sites (tests that don't
  // care about audit rows) compile unchanged; the router-factory always
  // passes a real repo in production.
  if (auditRepo) {
    await logProposalEvent(auditRepo, updated, 'proposal.approved', {
      id: actorId,
      role: actorRole,
    });
  }

  return updated;
}

/**
 * Decision 9 — 5-second undo window.
 *
 * Reverse an approval that was made in the last UNDO_WINDOW_MS.
 * Transitions an approved proposal to 'undone' (terminal). After the
 * window passes, undo fails — the only way to "undo" then is to
 * reverse the underlying entity via a new proposal.
 */
export async function undoProposal(
  proposalRepo: ProposalRepository,
  tenantId: string,
  proposalId: string,
  actorId: string,
  actorRole: Role,
  auditRepo?: AuditRepository,
): Promise<Proposal> {
  if (!hasPermission(actorRole, 'proposals:approve')) {
    // Same permission as approve — if you can approve you can undo.
    throw new ForbiddenError();
  }

  const proposal = await proposalRepo.findById(tenantId, proposalId);
  if (!proposal) {
    throw new NotFoundError('Proposal', proposalId);
  }

  if (proposal.status !== 'approved') {
    throw new ValidationError(
      `Cannot undo proposal in '${proposal.status}' status — only 'approved' proposals can be undone`
    );
  }

  if (!isInUndoWindow(proposal)) {
    throw new AppError(
      'UNDO_WINDOW_CLOSED',
      `Undo window has closed (${UNDO_WINDOW_MS}ms). To reverse the action, create a new proposal.`,
      409
    );
  }

  const transitioned = transitionProposal(proposal, 'undone', actorId);

  const updated = await proposalRepo.updateStatus(tenantId, proposalId, 'undone', {
    undoneAt: transitioned.undoneAt,
    undoneBy: transitioned.undoneBy,
  });
  if (!updated) {
    throw new NotFoundError('Proposal', proposalId);
  }

  // D2-1c — audit-log the undo so the timeline preserves the
  // approve→undo sequence (distinct event from rejected).
  if (auditRepo) {
    await logProposalEvent(auditRepo, updated, 'proposal.undone', {
      id: actorId,
      role: actorRole,
    });
  }

  return updated;
}

export async function rejectProposal(
  proposalRepo: ProposalRepository,
  tenantId: string,
  proposalId: string,
  actorId: string,
  actorRole: Role,
  reason: string,
  details?: string,
  appointmentRepo?: AppointmentRepository,
  auditRepo?: AuditRepository,
): Promise<Proposal> {
  if (!hasPermission(actorRole, 'proposals:approve')) {
    throw new ForbiddenError();
  }

  const proposal = await proposalRepo.findById(tenantId, proposalId);
  if (!proposal) {
    throw new NotFoundError('Proposal', proposalId);
  }

  const transitioned = transitionProposal(proposal, 'rejected', actorId);

  const updated = await proposalRepo.updateStatus(tenantId, proposalId, 'rejected', {
    rejectionReason: reason,
    rejectionDetails: details,
  });
  if (!updated) {
    throw new NotFoundError('Proposal', proposalId);
  }

  // D2-1c — audit-log the rejection. Built inline (vs. logProposalEvent)
  // so the rejection reason + details ride on metadata; the helper only
  // carries the proposalType + status by default.
  if (auditRepo) {
    await auditRepo.create(
      createAuditEvent({
        tenantId,
        actorId,
        actorRole,
        eventType: 'proposal.rejected',
        entityType: 'proposal',
        entityId: updated.id,
        metadata: {
          proposalType: updated.proposalType,
          status: updated.status,
          rejectionReason: reason,
          rejectionDetails: details,
        },
      }),
    );
  }

  // Releasing the held slot: a rejected create_booking proposal means
  // the owner declined the AI's tentative hold — cancel the held
  // appointment so the calendar slot frees up. Best-effort: a missing
  // appointmentRepo or a non-string appointmentId is simply skipped.
  if (
    appointmentRepo &&
    updated.proposalType === 'create_booking' &&
    typeof updated.payload.appointmentId === 'string'
  ) {
    const released = await updateAppointment(
      tenantId,
      updated.payload.appointmentId,
      { status: 'canceled', holdPendingApproval: false },
      appointmentRepo,
    );
    if (!released) {
      // The held appointment could not be found — the proposal is still
      // rejected, and the hold will auto-release at expiry (Task 3's
      // read-time release). Surface it so a stuck-looking calendar slot
      // after a rejection is diagnosable.
      console.warn(
        `Held appointment ${updated.payload.appointmentId} not found when releasing hold for rejected proposal ${proposalId}; it will auto-release at expiry.`
      );
    }
  }

  return updated;
}

export async function editProposal(
  proposalRepo: ProposalRepository,
  tenantId: string,
  proposalId: string,
  actorId: string,
  actorRole: Role,
  edits: Record<string, unknown>,
  auditRepo?: AuditRepository,
): Promise<{ proposal: Proposal; editedFields: string[] }> {
  if (!hasPermission(actorRole, 'proposals:edit')) {
    throw new ForbiddenError();
  }

  const proposal = await proposalRepo.findById(tenantId, proposalId);
  if (!proposal) {
    throw new NotFoundError('Proposal', proposalId);
  }

  if (proposal.status !== 'draft' && proposal.status !== 'ready_for_review') {
    throw new ValidationError(`Cannot edit proposal in '${proposal.status}' status`);
  }

  const updatedPayload = { ...proposal.payload, ...edits };

  const validation = validateProposalPayload(proposal.proposalType, updatedPayload);
  if (!validation.valid) {
    throw new ValidationError('Invalid payload after edit', { errors: validation.errors });
  }

  const editedFields = Object.keys(edits).filter(
    (key) => JSON.stringify(proposal.payload[key]) !== JSON.stringify(edits[key])
  );

  const updated = await proposalRepo.update(tenantId, proposalId, {
    payload: updatedPayload,
  });
  if (!updated) {
    throw new NotFoundError('Proposal', proposalId);
  }

  // D2-1c — audit-log the edit. Custom event (vs. logProposalEvent) so
  // editedFields rides on metadata; the inbox + history UI surfaces
  // which keys changed.
  if (auditRepo) {
    await auditRepo.create(
      createAuditEvent({
        tenantId,
        actorId,
        actorRole,
        eventType: 'proposal.edited',
        entityType: 'proposal',
        entityId: updated.id,
        metadata: {
          proposalType: updated.proposalType,
          status: updated.status,
          editedFields,
        },
      }),
    );
  }

  return { proposal: updated, editedFields };
}
