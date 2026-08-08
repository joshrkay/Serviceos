/**
 * Tradesperson wave 1, Task 6 — CreateChangeOrderTaskHandler (drafting leg).
 *
 * Standalone file per the quality-review ratchet (mirrors complaint-task.ts /
 * brand-voice-task.ts / apply-credit-task.ts) — voice-extended-tasks.ts is at
 * capacity, and new drafting handlers land in their own file from here on.
 *
 * `create_change_order` mints a NEW estimate pinned to an EXISTING job — a
 * mid-job scope change the customer asked for ("The Garcias want a second
 * zone — change order for 1800"), not a fresh bid. Capture-class (no money
 * moves at creation; sending the resulting estimate is a later, separate
 * comms-class step), same posture as `draft_estimate`.
 *
 * `jobId` resolution mirrors `UpdateJobTaskHandler` (job-edit-task.ts)
 * exactly: `create_change_order` joins `JOB_REF_INTENTS`
 * (ai/agents/customer-calling/entity-resolution.ts), so by the time this
 * handler runs the voice-action-router's entity resolver has already
 * resolved the spoken jobReference to a VERIFIED jobId and stamped it onto
 * `context.existingEntities.jobId` — a ROUTER-INJECTED id, never an
 * LLM-extracted field, so (like `apply_credit`'s invoiceId /
 * `UpdateJobTaskHandler`'s jobId) it is deliberately NOT added to
 * `ExtractedEntities` or the classifier's JSON template/parse allowlist.
 * `jobId` is REQUIRED on the contract — that's what makes this a change
 * order and not `draft_estimate` (whose jobId is optional). An unresolved
 * reference gates the proposal (`missingFields: ['jobId']`): a change order
 * without its job is meaningless.
 *
 * The added-work description (`changeOrderDescription`) becomes the change
 * order's title ("Change order — <description>") and the single line
 * item's description; a stated amount (`amount`, integer cents) becomes
 * that line's `unitPriceCents`. The line is then run through
 * `groundLineItemPricing` (ai/resolution/catalog-resolver.ts) — the SAME
 * tenant-catalog grounding pass `buildVoiceProposalPayload` / EstimateTaskHandler
 * use — so a catalog match overrides (or fills in) the price; an
 * uncatalogued spoken amount rides as-is, capped below auto-approve and
 * surfaced for human review via the RV-007 confidence-marker `_meta` (same
 * as every other catalog-grounded drafting handler). No LLM call: unlike
 * `draft_estimate`, the added work is a single named line, not a
 * multi-line quote the model needs to structure.
 *
 * Deliberately omits `sourceTrustTier` (never auto-approves in v1) —
 * mirrors `LogExpenseTaskHandler` / `ConfirmAppointmentTaskHandler`'s
 * posture for a deterministic, non-LLM capture handler; RBAC-wise this
 * type is dispatcher-approvable, same as `draft_estimate` (it is NOT in
 * `CONFIG_WRITING_PROPOSAL_TYPES`, proposals/actions.ts).
 */
import { createProposal, CreateProposalInput } from '../../proposals/proposal';
import type { TaskHandler, TaskContext, TaskResult } from './task-handlers';
import type { ExtractedEntities } from '../orchestration/intent-classifier';
import { CatalogItemRepository } from '../../catalog/catalog-item';
import {
  CatalogPricingOutcome,
  groundLineItemPricing,
  lineItemConfidenceSignals,
} from '../resolution/catalog-resolver';

const CHANGE_ORDER_PREFIX = 'Change order — ';

export class CreateChangeOrderTaskHandler implements TaskHandler {
  readonly taskType = 'create_change_order' as const;

  /**
   * P22 catalog grounding. When present, the drafted line item is resolved
   * against the tenant's active catalog and a match's price overrides the
   * spoken amount. Optional so callers/tests without a catalog repo keep
   * working (the line then rides the spoken amount as-is, uncatalogued).
   */
  private readonly catalogRepo?: CatalogItemRepository;

  constructor(catalogRepo?: CatalogItemRepository) {
    this.catalogRepo = catalogRepo;
  }

  async handle(context: TaskContext): Promise<TaskResult> {
    const ee = (context.existingEntities ?? {}) as ExtractedEntities & { jobId?: string };
    const payload: Record<string, unknown> = {};
    const missing: string[] = [];

    if (typeof ee.jobId === 'string' && ee.jobId.length > 0) {
      payload.jobId = ee.jobId;
    } else {
      missing.push('jobId');
    }

    const description =
      typeof ee.changeOrderDescription === 'string' && ee.changeOrderDescription.trim().length > 0
        ? ee.changeOrderDescription.trim()
        : undefined;

    payload.title = description ? `${CHANGE_ORDER_PREFIX}${description}` : 'Change order';

    const lineItem: Record<string, unknown> = {
      description: description ?? 'Additional work',
      quantity: 1,
    };
    if (typeof ee.amount === 'number' && ee.amount > 0) {
      lineItem.unitPriceCents = Math.round(ee.amount);
    }

    // Always resolve to an outcome — even with no catalog wired, an empty
    // catalog, or a read error, the line is treated as uncatalogued so a
    // human reviews an AI/spoken price rather than it silently auto-approving.
    const catalogOutcome: CatalogPricingOutcome = await groundLineItemPricing(
      [lineItem],
      'unitPriceCents',
      this.catalogRepo ? () => this.catalogRepo!.listByTenant(context.tenantId) : null,
    );
    payload.lineItems = catalogOutcome.lineItems;

    const confidenceFactors: string[] = [];
    if (catalogOutcome.anyCatalogPriced) confidenceFactors.push('catalog_priced');
    if (catalogOutcome.anyUncatalogued) confidenceFactors.push('uncatalogued_line_item');

    // RV-007 — Confidence Marker `_meta`, same translation every other
    // catalog-grounded drafting handler applies: an uncatalogued/ambiguous
    // line's pricingSource becomes a 'low' per-field marker for the review
    // card. No new confidence computation.
    const signals = lineItemConfidenceSignals(
      payload.lineItems as Array<Record<string, unknown>>,
      'unitPriceCents',
    );
    if (Object.keys(signals.fieldConfidence).length > 0 || signals.markers.length > 0) {
      payload._meta = {
        ...(Object.keys(signals.fieldConfidence).length > 0
          ? { fieldConfidence: signals.fieldConfidence }
          : {}),
        ...(signals.markers.length > 0 ? { markers: signals.markers } : {}),
      };
    }

    const sourceContext: Record<string, unknown> = {
      ...(context.conversationId ? { conversationId: context.conversationId } : {}),
      ...(catalogOutcome.catalogResolution ? { catalogResolution: catalogOutcome.catalogResolution } : {}),
    };

    const allMissing = [...catalogOutcome.missingFields, ...missing];

    const input: CreateProposalInput = {
      tenantId: context.tenantId,
      proposalType: this.taskType,
      payload,
      summary: context.message,
      confidenceFactors: confidenceFactors.length > 0 ? confidenceFactors : undefined,
      sourceContext: Object.keys(sourceContext).length > 0 ? sourceContext : undefined,
      createdBy: context.userId,
      missingFields: allMissing.length > 0 ? allMissing : undefined,
      ...(context.tenantThresholdOverride
        ? { tenantThresholdOverride: context.tenantThresholdOverride }
        : {}),
    };

    return { proposal: createProposal(input), taskType: this.taskType };
  }
}
