import { v4 as uuidv4 } from 'uuid';
import { Proposal, ProposalType } from '../proposal';
import { ExecutionContext, ExecutionHandler, ExecutionResult } from './handlers';
import { MaterialItemRepository } from '../../materials/material-item';
import { addMaterialPayloadSchema } from '../contracts/add-material';
import { AuditRepository, createAuditEvent } from '../../audit/audit';

/**
 * Executes an approved `add_material` proposal: persists a `material_items`
 * row (Task 8's substrate — `src/materials/material-item.ts`) and emits a
 * `material.requested` audit event. Follows the LogExpense house pattern
 * (`log-expense-handler.ts` / `create-service-agreement-handler.ts`):
 * validate the payload shape via the Zod contract, degrade to a
 * synthetic-id passthrough when the repo isn't wired (in-memory unit
 * fixtures), otherwise persist for real; audit emission is failure-soft (a
 * logging failure never unwinds a successful create).
 *
 * ── entityType: `material_item`, not `material` ──────────────────────────
 * Mirrors `service_agreement.created`'s choice (`entityType:
 * 'service_agreement'`, singular of the `service_agreements` table) over
 * the bare domain-object name — `material_items` is the table this handler
 * writes to, so `material_item` is what an operator/analytics consumer
 * looking the audit trail up against the schema will actually find.
 *
 * ── `material.requested`, not `material.added` ───────────────────────────
 * "Requested" names what actually happened from the shop's point of view:
 * a tradesperson asked for a part to be picked up, not that a part
 * physically arrived — `markPurchased` (material-item.ts) is the event
 * that would earn a past-tense "added"/"purchased" verb. Mirrors
 * `expense.logged`'s posture (the verb describes the operator's act, not
 * an inventory state change) rather than `service_agreement.created`'s
 * (a row genuinely came into being with no further verb needed) — a
 * material_items row DOES come into being here too, but "requested" reads
 * truer to a shopping list than "created" would.
 *
 * ── Idempotent replay, not just a synthetic-id passthrough ───────────────
 * Like `create_change_order`/`create_service_agreement`, this handler mints
 * a brand NEW row on every `execute()` call — a `resultEntityId` already
 * stamped on the proposal short-circuits to a pure replay so a
 * redelivered/re-executed approval can never double-add the same item.
 *
 * ── No `_meta` confidence marker ──────────────────────────────────────────
 * There is no catalog grounding or LLM call anywhere in this type's
 * drafting leg (`ai/tasks/add-material-task.ts`) that would produce a real
 * confidence signal on a shopping-list line — `_meta` is never built here,
 * matching `create_service_agreement`'s "omit rather than fabricate"
 * posture (`overallConfidence` is a REQUIRED field on the shared `_meta`
 * envelope whenever `_meta` is present at all).
 */
export class AddMaterialExecutionHandler implements ExecutionHandler {
  proposalType: ProposalType = 'add_material';

  constructor(
    private readonly materialItemRepo?: MaterialItemRepository,
    private readonly auditRepo?: AuditRepository,
  ) {}

  // WS3 — degrades to a synthetic-id passthrough (saves nothing) without
  // the material item repo. Boot fails when a pool is configured but this
  // is false.
  isFullyWired(): boolean {
    return Boolean(this.materialItemRepo);
  }

  async execute(proposal: Proposal, context: ExecutionContext): Promise<ExecutionResult> {
    const parsed = addMaterialPayloadSchema.safeParse(proposal.payload);
    if (!parsed.success) {
      return {
        success: false,
        error: 'Could not determine the material to add (missing description or an invalid quantity).',
      };
    }

    // A brand-new row is minted on every execute() — replay the prior
    // result instead of double-adding the same item (see class doc
    // comment above).
    if (proposal.resultEntityId) {
      return { success: true, resultEntityId: proposal.resultEntityId };
    }

    if (!this.materialItemRepo) {
      return { success: true, resultEntityId: uuidv4() };
    }

    const { description, quantity, jobId, vendor, neededBy } = parsed.data;

    let itemId: string;
    try {
      const item = await this.materialItemRepo.create({
        tenantId: context.tenantId,
        ...(jobId ? { jobId } : {}),
        description,
        quantity,
        ...(vendor ? { vendor } : {}),
        // neededBy is a bare YYYY-MM-DD calendar date (contract-validated) —
        // parsed at midnight UTC so it never shifts a day depending on the
        // server's local timezone, mirroring how contracts/
        // create-service-agreement.ts's startsOn is fed to Date.UTC.
        ...(neededBy ? { neededBy: new Date(`${neededBy}T00:00:00Z`) } : {}),
        createdBy: context.executedBy,
      });
      itemId = item.id;
    } catch (err) {
      return {
        success: false,
        error: `Failed to add material: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    if (this.auditRepo) {
      try {
        await this.auditRepo.create(
          createAuditEvent({
            tenantId: context.tenantId,
            actorId: context.executedBy,
            actorRole: context.executedByRole ?? 'voice_agent',
            eventType: 'material.requested',
            entityType: 'material_item',
            entityId: itemId,
            metadata: {
              proposalId: proposal.id,
              proposalType: 'add_material',
              quantity,
              ...(jobId ? { jobId } : {}),
            },
          }),
        );
      } catch (auditErr) {
        // Audit failures must not unwind a successful material create —
        // but they MUST be diagnosable. Mirrors LogExpenseExecutionHandler /
        // CreateServiceAgreementExecutionHandler.
        const msg = auditErr instanceof Error ? auditErr.message : String(auditErr);
        console.warn(
          `Failed to emit material.requested audit event for material item ${itemId} (proposal ${proposal.id}): ${msg}`,
        );
      }
    }

    return { success: true, resultEntityId: itemId };
  }
}
