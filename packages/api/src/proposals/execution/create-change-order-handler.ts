import { v4 as uuidv4 } from 'uuid';
import { Proposal, ProposalType } from '../proposal';
import { ExecutionContext, ExecutionHandler, ExecutionResult, normalizeDraftLineItems } from './handlers';
import { EstimateRepository, createEstimate } from '../../estimates/estimate';
import { SettingsRepository, getNextEstimateNumber } from '../../settings/settings';
import { AuditRepository, createAuditEvent } from '../../audit/audit';
import { createChangeOrderPayloadSchema, ensureChangeOrderTitle } from '../contracts/create-change-order';

/**
 * Executes an approved `create_change_order` proposal: mints a NEW estimate
 * pinned to the EXISTING job named on the payload, flagged
 * `isChangeOrder: true` (migration 271), and emits a
 * `estimate.change_order_created` audit event. Follows the LogExpense
 * house pattern (`log-expense-handler.ts`): validate the payload shape via
 * the Zod contract, degrade to a synthetic-id passthrough when the
 * `estimateRepo` isn't wired (in-memory unit fixtures), otherwise persist
 * for real.
 *
 * Unlike `DraftEstimateExecutionHandler`, this handler never derives or
 * auto-opens a job for a missing customer/jobId: `jobId` is a REQUIRED
 * field on the contract (that's what makes this a change order, not a
 * fresh bid), and `CreateEstimateInput` carries no `customerId` at all —
 * the linked job already owns that relationship. A `jobId` naming a
 * nonexistent (or cross-tenant) job fails at the `estimates.job_id`
 * foreign key, surfaced as an honest `{ success: false, error }` — the
 * same failure mode every other estimate-creating path already has.
 *
 * `estimateNumber` is NOT on the payload — like every other estimate-
 * creating path, it's minted at execution time via
 * `getNextEstimateNumber` (settings/settings.ts), which needs a
 * `SettingsRepository`. So this handler needs BOTH `estimateRepo` and
 * `settingsRepo` to be fully wired, exactly like
 * `DraftEstimateExecutionHandler`.
 *
 * Deliberately does NOT thread `auditRepo` into `createEstimate()` (which
 * would additionally emit a generic `estimate.created` event): migration
 * 271 exists precisely so reporting can separate change-order scope-adds
 * from original bids, and double-emitting `estimate.created` here would
 * pollute that same `estimate_created` product-analytics counter
 * (analytics/audit-event-mapping.ts) with change-order volume. This
 * handler's own `estimate.change_order_created` event is the sole record,
 * deliberately unmapped there — mirroring `credit.applied` / `refund.recorded`
 * / `expense.logged`'s unmapped-by-design posture.
 */
export class CreateChangeOrderExecutionHandler implements ExecutionHandler {
  proposalType: ProposalType = 'create_change_order';

  constructor(
    private readonly estimateRepo?: EstimateRepository,
    private readonly settingsRepo?: SettingsRepository,
    private readonly auditRepo?: AuditRepository,
  ) {}

  // WS3 — degrades to a synthetic-id passthrough (saves nothing) without
  // BOTH the estimate repo and the settings repo (estimate numbering, same
  // as DraftEstimateExecutionHandler). Boot fails when a pool is
  // configured but this is false.
  isFullyWired(): boolean {
    return Boolean(this.estimateRepo) && Boolean(this.settingsRepo);
  }

  async execute(proposal: Proposal, context: ExecutionContext): Promise<ExecutionResult> {
    const parsed = createChangeOrderPayloadSchema.safeParse(proposal.payload);
    if (!parsed.success) {
      return {
        success: false,
        error: 'Could not determine the change order to draft (missing job, title, or line items).',
      };
    }
    const { jobId, lineItems: rawLineItems, customerMessage } = parsed.data;
    // Quality-review fix — ensureChangeOrderTitle (contracts/create-change-
    // order.ts) is idempotent against BOTH shapes the drafting task can
    // produce (prefixed, or the bare 'Change order' fallback when no work
    // description was spoken); a bare startsWith('Change order — ') check
    // here previously double-prefixed the bare fallback into
    // "Change order — Change order — created from voice change-order
    // proposal <id>".
    const title = ensureChangeOrderTitle(parsed.data.title);

    if (proposal.resultEntityId) {
      return { success: true, resultEntityId: proposal.resultEntityId };
    }

    if (!this.estimateRepo || !this.settingsRepo) {
      return { success: true, resultEntityId: uuidv4() };
    }

    const { lineItems, malformed } = normalizeDraftLineItems(rawLineItems);
    if (malformed.length > 0) {
      return {
        success: false,
        error: `Change order has line items that can't be priced: ${malformed.join('; ')}`,
      };
    }

    try {
      const estimateNumber = await getNextEstimateNumber(context.tenantId, this.settingsRepo);
      const estimate = await createEstimate(
        {
          tenantId: context.tenantId,
          jobId,
          estimateNumber,
          isChangeOrder: true,
          lineItems,
          customerMessage,
          internalNotes: `${title} — created from voice change-order proposal ${proposal.id}`,
          createdBy: context.executedBy,
        },
        this.estimateRepo,
      );

      if (this.auditRepo) {
        try {
          await this.auditRepo.create(
            createAuditEvent({
              tenantId: context.tenantId,
              actorId: context.executedBy,
              actorRole: 'voice_agent',
              eventType: 'estimate.change_order_created',
              entityType: 'estimate',
              entityId: estimate.id,
              metadata: { proposalId: proposal.id, proposalType: 'create_change_order', jobId },
            }),
          );
        } catch (auditErr) {
          // Audit failures must not unwind a successful estimate create —
          // but they MUST be diagnosable. Mirrors LogExpenseExecutionHandler.
          const msg = auditErr instanceof Error ? auditErr.message : String(auditErr);
          console.warn(
            `Failed to emit estimate.change_order_created audit event for estimate ${estimate.id} (proposal ${proposal.id}): ${msg}`,
          );
        }
      }

      return { success: true, resultEntityId: estimate.id };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
