import { Proposal, ProposalType } from '../proposal';
import { ExecutionHandler, ExecutionContext, ExecutionResult } from './handlers';
import { EstimateRepository, updateEstimate } from '../../estimates/estimate';
import {
  applyEstimateEdits,
  EstimateEditAction,
} from '../../estimates/estimate-editor';
import { AuditRepository } from '../../audit/audit';
import { DocumentRevisionRepository } from '../../ai/document-revision';
import { EditDeltaRepository } from '../../estimates/edit-delta';
import { ValidationError, ConflictError } from '../../shared/errors';

/**
 * Executes `update_estimate` proposals by applying the edit actions in
 * the payload to the target estimate. The pure edit logic lives in
 * estimates/estimate-editor.ts; persistence is delegated to
 * `updateEstimate` so the voice path gets the SAME version bump,
 * revision snapshot, and audit event as the authenticated edit path —
 * otherwise a voice edit changes contents without advancing `version`,
 * letting a customer accept stale pricing through the version guard.
 *
 * Failure modes return ExecutionResult.success=false (missing payload,
 * missing estimate, wrong tenant, non-editable status, validation
 * errors from the editor). Transient repo errors throw so the
 * executor can retry — matches the convention in handlers.ts.
 */
export class UpdateEstimateExecutionHandler implements ExecutionHandler {
  proposalType: ProposalType = 'update_estimate';

  constructor(
    private readonly estimateRepo: EstimateRepository,
    private readonly auditRepo?: AuditRepository,
    private readonly docRevisionRepo?: DocumentRevisionRepository,
    private readonly editDeltaRepo?: EditDeltaRepository,
  ) {}

  async execute(proposal: Proposal, context: ExecutionContext): Promise<ExecutionResult> {
    const { payload } = proposal;

    if (!payload || typeof payload !== 'object') {
      return { success: false, error: 'Payload is required' };
    }

    const estimateId = (payload as Record<string, unknown>).estimateId;
    if (!estimateId || typeof estimateId !== 'string') {
      return { success: false, error: 'Payload must include a valid estimateId' };
    }

    const editActions = (payload as Record<string, unknown>).editActions;
    if (!Array.isArray(editActions) || editActions.length === 0) {
      return { success: false, error: 'Payload must include at least one editAction' };
    }

    const estimate = await this.estimateRepo.findById(proposal.tenantId, estimateId);
    if (!estimate) {
      return { success: false, error: `Estimate ${estimateId} not found in this tenant` };
    }

    try {
      // Compute the post-edit line items, then persist through
      // updateEstimate so version/revision/audit stay consistent with the
      // authenticated PUT/PATCH path (which is the source of truth for the
      // optimistic-lock + stale-accept guards).
      //
      // RV-042: an update_estimate against an ACCEPTED estimate invalidates
      // the acceptance instead of refusing — updateEstimate clears the
      // acceptance fields, returns the estimate to 'sent' (re-sendable),
      // and records the prior acceptance in an
      // `estimate.acceptance_invalidated` audit event.
      const { updatedEstimate } = applyEstimateEdits(
        estimate,
        editActions as EstimateEditAction[],
        { allowAccepted: true },
      );
      const persisted = await updateEstimate(
        proposal.tenantId,
        estimateId,
        { lineItems: updatedEstimate.lineItems },
        this.estimateRepo,
        {
          auditRepo: this.auditRepo,
          docRevisionRepo: this.docRevisionRepo,
          editDeltaRepo: this.editDeltaRepo,
          actorId: context.executedBy,
          actorRole: 'system',
          invalidateAcceptance: true,
        },
      );
      if (!persisted) {
        return { success: false, error: `Estimate ${estimateId} not found in this tenant` };
      }
      return { success: true, resultEntityId: persisted.id };
    } catch (err) {
      // Both are permanent, non-retryable refusals (bad input or a
      // status/deposit lock) — surface as a soft failure rather than
      // throwing, which would make the executor retry pointlessly.
      if (err instanceof ValidationError || err instanceof ConflictError) {
        return { success: false, error: err.message };
      }
      throw err;
    }
  }
}
