/**
 * UB-A2 (agent wave) — create_standing_instruction execution handler.
 *
 * Runs ONLY after human approval (the voice task handler omits
 * sourceTrustTier, so the proposal always drafts for review). Inserts the
 * directive through the UB-A1 domain service — which enforces the 500-char
 * cap, validates the scope, applies the 20-active-per-tenant repo cap, and
 * emits the `standing_instruction.created` audit event — with source
 * 'proposal' so settings-created and voice-captured rows stay distinguishable.
 *
 * Idempotency follows the simple-capture convention (see add_note /
 * create_job): a proposal that already carries `resultEntityId` short-circuits
 * to success with the existing id, so an executor retry can never insert the
 * same instruction twice. Without a repo wired the handler degrades to a
 * synthetic-id passthrough and reports `isFullyWired() === false` for the
 * boot-time wiring guard.
 */
import { v4 as uuidv4 } from 'uuid';
import {
  createStandingInstruction,
  StandingInstructionRepository,
  standingInstructionScopeSchema,
} from '../../instructions/standing-instructions';
import { AuditRepository } from '../../audit/audit';
import { Proposal, ProposalType } from '../proposal';
import { ExecutionContext, ExecutionHandler, ExecutionResult } from './handlers';

export class CreateStandingInstructionExecutionHandler implements ExecutionHandler {
  proposalType: ProposalType = 'create_standing_instruction';

  constructor(
    private readonly repo?: StandingInstructionRepository,
    private readonly auditRepo?: AuditRepository,
  ) {}

  // Degrades to a synthetic-id passthrough (saves nothing) without the repo.
  isFullyWired(): boolean {
    return Boolean(this.repo);
  }

  async execute(proposal: Proposal, context: ExecutionContext): Promise<ExecutionResult> {
    const { payload } = proposal;
    if (typeof payload.instruction !== 'string' || payload.instruction.trim().length === 0) {
      return { success: false, error: 'Payload must include a non-empty instruction' };
    }
    const scopeResult = standingInstructionScopeSchema.safeParse(payload.scope ?? {});
    if (!scopeResult.success) {
      return { success: false, error: 'Payload scope is invalid' };
    }

    if (proposal.resultEntityId) {
      return { success: true, resultEntityId: proposal.resultEntityId };
    }

    if (!this.repo) {
      return { success: true, resultEntityId: uuidv4() };
    }

    try {
      const created = await createStandingInstruction(
        {
          tenantId: context.tenantId,
          instruction: payload.instruction,
          scope: scopeResult.data,
          source: 'proposal',
          createdBy: context.executedBy,
          actorRole: 'system',
        },
        this.repo,
        this.auditRepo,
      );
      return { success: true, resultEntityId: created.id };
    } catch (err) {
      // Includes StandingInstructionLimitError (tenant at the 20-active cap):
      // surfaced as execution_failed with the typed message so the review UI
      // tells the owner to deactivate one first.
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
