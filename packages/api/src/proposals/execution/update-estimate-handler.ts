import { Proposal, ProposalType } from '../proposal';
import { ExecutionHandler, ExecutionContext, ExecutionResult } from './handlers';
import { EstimateRepository } from '../../estimates/estimate';
import {
  applyEstimateEdits,
  EstimateEditAction,
} from '../../estimates/estimate-editor';
import { ValidationError } from '../../shared/errors';

/**
 * Executes `update_estimate` proposals by applying the edit actions in
 * the payload to the target estimate. The pure edit logic lives in
 * estimates/estimate-editor.ts; this handler is the persistence
 * boundary: fetch, delegate, write-back, return a result.
 *
 * Failure modes return ExecutionResult.success=false (missing payload,
 * missing estimate, wrong tenant, non-editable status, validation
 * errors from the editor). Transient repo errors throw so the
 * executor can retry — matches the convention in handlers.ts.
 *
 * Note: this replaces the previous stub handler which only validated
 * estimateId and returned success. The Phase-2b rewrite gives voice
 * edits a real execution path.
 */
export class UpdateEstimateExecutionHandler implements ExecutionHandler {
  proposalType: ProposalType = 'update_estimate';

  constructor(private readonly estimateRepo: EstimateRepository) {}

  async execute(proposal: Proposal, _context: ExecutionContext): Promise<ExecutionResult> {
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
      const { updatedEstimate } = applyEstimateEdits(
        estimate,
        editActions as EstimateEditAction[]
      );
      await this.estimateRepo.update(proposal.tenantId, estimateId, {
        lineItems: updatedEstimate.lineItems,
        totals: updatedEstimate.totals,
        updatedAt: updatedEstimate.updatedAt,
      });
      return { success: true, resultEntityId: estimate.id };
    } catch (err) {
      if (err instanceof ValidationError) {
        return { success: false, error: err.message };
      }
      throw err;
    }
  }
}
