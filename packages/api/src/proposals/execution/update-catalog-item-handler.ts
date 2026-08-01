/**
 * WS20 — update_catalog_item execution handler.
 *
 * Runs ONLY after human approval (the correction loop creates the proposal
 * with no trust tier, so it always lands for review — D-004). Wraps the
 * catalog domain function `updateCatalogItem`, which persists the new unit
 * price and emits its own `catalog_item.updated` audit event; the executor
 * additionally writes the WS11 `proposal.executed` audit in the same
 * transaction, so the state change can't commit without an audit row.
 *
 * Idempotency follows the simple-capture convention (see add_note /
 * create_standing_instruction): a proposal that already carries
 * `resultEntityId` short-circuits to success, so an executor retry can never
 * re-run the update. Without a repo wired the handler degrades to a
 * synthetic-passthrough and reports `isFullyWired() === false` for the
 * boot-time wiring guard.
 */
import {
  CatalogItemRepository,
  updateCatalogItem,
} from '../../catalog/catalog-item';
import { AuditRepository } from '../../audit/audit';
import { Proposal, ProposalType } from '../proposal';
import { ExecutionContext, ExecutionHandler, ExecutionResult } from './handlers';

export class UpdateCatalogItemExecutionHandler implements ExecutionHandler {
  proposalType: ProposalType = 'update_catalog_item';

  constructor(
    private readonly catalogRepo?: CatalogItemRepository,
    private readonly auditRepo?: AuditRepository,
  ) {}

  // Degrades to a synthetic passthrough (persists nothing) without the repo.
  isFullyWired(): boolean {
    return Boolean(this.catalogRepo);
  }

  async execute(proposal: Proposal, context: ExecutionContext): Promise<ExecutionResult> {
    const { payload } = proposal;
    const catalogItemId = payload.catalogItemId;
    if (typeof catalogItemId !== 'string' || catalogItemId.length === 0) {
      return { success: false, error: 'Payload must include a valid catalogItemId' };
    }
    const proposedUnitPriceCents = payload.proposedUnitPriceCents;
    if (
      typeof proposedUnitPriceCents !== 'number' ||
      !Number.isInteger(proposedUnitPriceCents) ||
      proposedUnitPriceCents < 0
    ) {
      return { success: false, error: 'Payload must include a non-negative integer proposedUnitPriceCents' };
    }

    if (proposal.resultEntityId) {
      return { success: true, resultEntityId: proposal.resultEntityId };
    }

    if (!this.catalogRepo) {
      return { success: true, resultEntityId: catalogItemId };
    }

    try {
      const updated = await updateCatalogItem(
        this.catalogRepo,
        context.tenantId,
        catalogItemId,
        { unitPriceCents: proposedUnitPriceCents },
        { userId: context.executedBy, role: 'system' },
        this.auditRepo,
      );
      if (!updated) {
        return { success: false, error: 'Catalog item not found' };
      }
      return { success: true, resultEntityId: updated.id };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
