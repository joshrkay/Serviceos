import { TaskHandler, TaskContext, TaskResult } from './task-handlers';
import { createProposal, CreateProposalInput } from '../../proposals/proposal';
import { LLMGateway } from '../gateway/gateway';
import { assessConfidence, getConfidenceLevel } from '../guardrails/confidence';
import type { ConfidenceLevel } from '../guardrails/confidence';
import type { ProposalConfidenceMeta } from '../../proposals/contracts';
import type { Estimate, EstimateRepository } from '../../estimates/estimate';
import type { CatalogItem, CatalogItemRepository } from '../../catalog/catalog-item';
import {
  buildCatalogPromptSection,
  resolveSpokenLineItems,
} from './catalog-resolution';
import { UNCATALOGUED_CONFIDENCE_CAP } from '../resolution/catalog-resolver';

/**
 * EstimateEditTaskHandler — produces `update_estimate` proposals from
 * voice transcripts like:
 *   "Add a site visit for $150 to estimate EST-0001"
 *   "Remove the disposal fee from the Johnson estimate"
 *   "Add a trip fee and remove the old heater from EST-0001"
 *
 * LLM output includes an `estimateReference` (string hint — number,
 * customer name, whatever the operator said) plus edit actions. The
 * review step resolves the reference to a concrete estimate id before
 * execution, same pattern as InvoiceEditTaskHandler.
 *
 * Structural shape matches what applyEstimateEdits consumes in
 * estimates/estimate-editor.ts.
 */

const ESTIMATE_EDIT_SYSTEM_PROMPT = `You edit draft estimates for a field service operating system.
Given a voice transcript from an operator, extract (1) which estimate they want
to change and (2) what changes they want applied.

Return valid JSON only (no prose, no markdown fences):
{
  "estimateReference": "<string — estimate number, customer name, or whatever the operator said>",
  "editActions": [
    {
      "type": "add_line_item",
      "lineItem": {
        "description": "<string>",
        "quantity": <number>,
        "unitPrice": <integer cents>,
        "category": "labor" | "material" | "equipment" | "other" (optional)
      }
    },
    {
      "type": "remove_line_item",
      "description": "<short phrase matching the line-item description, e.g. 'disposal fee'>"
    },
    {
      "type": "update_line_item",
      "description": "<phrase matching existing line item>",
      "lineItem": { same shape as add_line_item }
    }
  ],
  "confidence_score": <number between 0 and 1>
}

Rules:
- unitPrice is ALWAYS integer cents. $150 → 15000. Never decimals.
- If the operator says "remove the disposal fee", use type "remove_line_item"
  with description: "disposal fee". The execution step matches it against the
  real line items on the estimate by description.
- If you can't identify either the estimate or a concrete edit, set confidence
  below 0.7. Empty editActions is acceptable when the transcript is truly
  ambiguous — don't fabricate.
- Never invent an estimate id or customer name. Use only what the transcript says.`;

function tryParseJson(content: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(content);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function buildPayload(parsed: Record<string, unknown> | null): Record<string, unknown> {
  if (!parsed) return { editActions: [] };
  const payload: Record<string, unknown> = {};

  if (typeof parsed.estimateReference === 'string') {
    payload.estimateReference = parsed.estimateReference;
  }

  // Rare but allowed by the contract: a concrete estimateId (e.g. when the
  // classifier hints carried a verified id). Passed through so execution
  // can skip reference resolution.
  if (typeof parsed.estimateId === 'string') {
    payload.estimateId = parsed.estimateId;
  }

  if (Array.isArray(parsed.editActions)) {
    payload.editActions = parsed.editActions;
  } else {
    payload.editActions = [];
  }

  return payload;
}

/**
 * VOX-50 — catalog grounding for voice estimate-edit line items.
 *
 * Runs the SAME money-correctness contract as draft_estimate: an
 * AI-invented price must never be trusted into an auto-approvable
 * proposal. For every `add_line_item` / `update_line_item`:
 *   - resolved to exactly one catalog item → the catalog's
 *     `unitPriceCents` OVERWRITES the LLM's guess (both `unitPrice`, the
 *     field the estimate editor executes against, and its `unitPriceCents`
 *     mirror) and `catalogItemId` is stamped.
 *   - unresolved (uncatalogued, ambiguous, OR no catalog to ground
 *     against — empty/unwired) → the LLM price is UNTRUSTED: flagged
 *     `pricingSource:'uncatalogued'` + `needsPricing:true`, `unitPriceCents`
 *     nulled, and the line drives `anyUncatalogued` so the handler caps
 *     confidence AND stamps `_meta.overallConfidence:'low'` — which
 *     hard-blocks auto-approval in decideInitialStatus. The executable
 *     `unitPrice` is kept numeric only to satisfy the update_estimate Zod
 *     contract; it can never reach execution without a human first
 *     reviewing the low-confidence proposal.
 *
 * Empty catalog is NOT a short-circuit (that was the VOX-51 hole): with
 * no catalog every priced line is uncatalogued, exactly like the draft
 * path's markAllUncatalogued.
 */
interface EditGroundingResult {
  payload: Record<string, unknown>;
  anyUncatalogued: boolean;
  anyCatalogPriced: boolean;
  markers: Array<{ path: string; reason: string }>;
  fieldConfidence: Record<string, ConfidenceLevel>;
}

function groundEditActionPricing(
  payload: Record<string, unknown>,
  catalogItems: CatalogItem[],
): EditGroundingResult {
  const markers: Array<{ path: string; reason: string }> = [];
  const fieldConfidence: Record<string, ConfidenceLevel> = {};
  let anyUncatalogued = false;
  let anyCatalogPriced = false;

  if (!Array.isArray(payload.editActions)) {
    return { payload, anyUncatalogued, anyCatalogPriced, markers, fieldConfidence };
  }

  const editActions = (payload.editActions as Array<Record<string, unknown>>).map((action, idx) => {
    if (
      !action ||
      (action.type !== 'add_line_item' && action.type !== 'update_line_item') ||
      typeof action.lineItem !== 'object' ||
      action.lineItem === null
    ) {
      return action;
    }

    const lineItem = action.lineItem as Record<string, unknown>;
    const description = typeof lineItem.description === 'string' ? lineItem.description : '';
    const quantity = typeof lineItem.quantity === 'number' ? lineItem.quantity : undefined;

    // No catalog to ground against ⇒ every priced line is uncatalogued
    // (never trust the LLM price), mirroring markAllUncatalogued.
    const resolved =
      catalogItems.length > 0
        ? resolveSpokenLineItems(
            [{ description, ...(quantity !== undefined ? { quantity } : {}) }],
            catalogItems,
          ).resolved
        : [];

    if (resolved.length === 1) {
      const match = resolved[0];
      anyCatalogPriced = true;
      return {
        ...action,
        lineItem: {
          ...lineItem,
          description: match.description,
          quantity: match.quantity,
          // Catalog price ALWAYS overwrites the LLM guess. `unitPrice` is
          // the executable field (estimate-editor reads it); `unitPriceCents`
          // mirrors it for the approval UI.
          unitPrice: match.unitPriceCents,
          unitPriceCents: match.unitPriceCents,
          catalogItemId: match.catalogItemId,
          pricingSource: 'catalog',
          needsPricing: false,
        },
      };
    }

    // Unresolved / ambiguous / no-catalog: the LLM price is untrusted.
    anyUncatalogued = true;
    const path = `editActions[${idx}].lineItem.unitPrice`;
    fieldConfidence[path] = 'low';
    markers.push({
      path,
      reason: `"${description}" is not in the tenant catalog — the price is AI-estimated and needs review`,
    });
    return {
      ...action,
      lineItem: {
        ...lineItem,
        // Executable `unitPrice` kept numeric for the Zod contract, but the
        // proposal cannot auto-approve (see _meta low + confidence cap).
        unitPriceCents: null,
        pricingSource: 'uncatalogued',
        needsPricing: true,
      },
    };
  });

  return {
    payload: { ...payload, editActions },
    anyUncatalogued,
    anyCatalogPriced,
    markers,
    fieldConfidence,
  };
}

/** RV-042 — review-time marker for edits that void a customer's acceptance. */
export const ACCEPTANCE_VOID_MARKER = {
  path: '_acceptance',
  reason: "approving voids the customer's prior acceptance",
} as const;

export class EstimateEditTaskHandler implements TaskHandler {
  readonly taskType = 'update_estimate' as const;
  private readonly gateway: LLMGateway;
  /**
   * RV-042 — review-time visibility of acceptance voiding. When wired, the
   * handler resolves the targeted estimate (by id when the payload carries
   * one, else by an unambiguous estimateReference match) and, if it is
   * CURRENTLY ACCEPTED, stamps `_meta.markers` with ACCEPTANCE_VOID_MARKER
   * so the SMS/UI review surfaces warn the approver that approving voids
   * the customer's prior acceptance. Absent repo → marker skipped (the
   * execute-time invalidation audit still records the voiding).
   */
  private readonly estimateRepo?: Pick<EstimateRepository, 'findById' | 'findByTenant'>;
  /**
   * VOX-50 catalog grounding. When present, edit line items are resolved
   * against the tenant's active catalog and matched prices OVERRIDE the
   * LLM's numbers; uncatalogued/ambiguous lines cap confidence and stamp
   * `_meta.overallConfidence:'low'` so an AI-invented edit price can never
   * auto-approve. Optional so existing callers/tests are unaffected.
   */
  private readonly catalogRepo?: CatalogItemRepository;

  constructor(
    gateway: LLMGateway,
    estimateRepo?: Pick<EstimateRepository, 'findById' | 'findByTenant'>,
    catalogRepo?: CatalogItemRepository,
  ) {
    this.gateway = gateway;
    this.estimateRepo = estimateRepo;
    this.catalogRepo = catalogRepo;
  }

  /**
   * Fetch the tenant's active catalog. Best-effort: a catalog hiccup
   * degrades to the uncatalogued path (capped, human-reviewed) rather
   * than failing the voice turn. Tenant isolation rides the repo's
   * tenantId-first contract.
   */
  private async fetchCatalog(tenantId: string): Promise<CatalogItem[]> {
    if (!this.catalogRepo) return [];
    try {
      const items = await this.catalogRepo.listByTenant(tenantId);
      return items.filter((i) => i.archivedAt === null);
    } catch {
      return [];
    }
  }

  async handle(context: TaskContext): Promise<TaskResult> {
    const catalogItems = await this.fetchCatalog(context.tenantId);

    const llmResponse = await this.gateway.complete({
      taskType: 'update_estimate',
      messages: [
        { role: 'system', content: ESTIMATE_EDIT_SYSTEM_PROMPT },
        { role: 'user', content: this.buildUserMessage(context, catalogItems) },
      ],
      responseFormat: 'json',
    });

    const parsed = tryParseJson(llmResponse.content);
    const grounding = groundEditActionPricing(buildPayload(parsed), catalogItems);
    const payload = grounding.payload;

    const confidence = assessConfidence(parsed ?? {});
    let confidenceScore = confidence.score;
    const confidenceFactors = [...confidence.factors];
    if (grounding.anyCatalogPriced) confidenceFactors.push('catalog_priced');
    if (grounding.anyUncatalogued) {
      confidenceFactors.push('uncatalogued_line_item');
      // Money-correctness gate: an AI-invented price must never ride a
      // ≥0.9 confidence score into autonomous auto-approval.
      confidenceScore = Math.min(confidenceScore, UNCATALOGUED_CONFIDENCE_CAP);
    }

    // RV-042 acceptance-void marker + VOX-50 catalog markers MERGE into a
    // single `_meta` — overwriting the whole object would clobber whichever
    // path ran, so both contribute. Acceptance marker stays first.
    const target = await this.resolveTargetEstimate(context.tenantId, payload);
    const accepted = target?.status === 'accepted';
    if (accepted || grounding.anyUncatalogued || grounding.anyCatalogPriced) {
      const markers = [
        ...(accepted ? [ACCEPTANCE_VOID_MARKER] : []),
        ...grounding.markers,
      ];
      const meta: ProposalConfidenceMeta = {
        // Any ungrounded (LLM-priced) line hard-blocks auto-approval via the
        // RV-007 confidence-marker guard — independent of the numeric score
        // AND of any tenant auto_approve_threshold override. An AI-invented
        // edit price must always reach a human.
        overallConfidence: grounding.anyUncatalogued
          ? 'low'
          : getConfidenceLevel(confidenceScore),
        ...(Object.keys(grounding.fieldConfidence).length > 0
          ? { fieldConfidence: grounding.fieldConfidence }
          : {}),
        ...(markers.length > 0 ? { markers } : {}),
      };
      payload._meta = meta;
    }

    const input: CreateProposalInput = {
      tenantId: context.tenantId,
      proposalType: this.taskType,
      payload,
      summary: context.message,
      confidenceScore,
      confidenceFactors,
      sourceContext: context.conversationId ? { conversationId: context.conversationId } : undefined,
      createdBy: context.userId,
      // Estimate edits target existing entities but only in editable
      // statuses (draft / ready_for_review). Sent estimates are locked
      // at execute time. Classified as `capture`, same as draft_estimate.
      sourceTrustTier: 'autonomous',
      // PR B — propagate tenant override from context.
      ...(context.tenantThresholdOverride
        ? { tenantThresholdOverride: context.tenantThresholdOverride }
        : {}),
      // Phase 12 — forward supervisor presence so this autonomous, capture-class
      // edit only auto-approves when a supervisor is on the wall (same gate as
      // the create_appointment path).
      ...(context.supervisorPresent !== undefined
        ? { supervisorPresent: context.supervisorPresent }
        : {}),
      ...(context.supervisorMode ? { supervisorMode: context.supervisorMode } : {}),
    };

    return { proposal: createProposal(input), taskType: this.taskType };
  }

  /**
   * Best-effort target resolution for the acceptance-void marker. Never
   * throws — a repo hiccup or an ambiguous reference simply skips the
   * marker (the hard guarantees live at execute time).
   */
  private async resolveTargetEstimate(
    tenantId: string,
    payload: Record<string, unknown>,
  ): Promise<Estimate | null> {
    if (!this.estimateRepo) return null;
    try {
      if (typeof payload.estimateId === 'string' && payload.estimateId.length > 0) {
        return await this.estimateRepo.findById(tenantId, payload.estimateId);
      }
      const reference = payload.estimateReference;
      if (typeof reference === 'string' && reference.trim().length > 0) {
        // ILIKE search on estimate_number / customer_message; only an
        // UNAMBIGUOUS single match identifies the target.
        const matches = await this.estimateRepo.findByTenant(tenantId, {
          search: reference.trim(),
          limit: 2,
        });
        if (matches.length === 1) return matches[0];
      }
    } catch {
      // Marker resolution must never block proposal creation.
    }
    return null;
  }

  private buildUserMessage(context: TaskContext, catalogItems: CatalogItem[] = []): string {
    const parts: string[] = [];
    parts.push(`Transcript: ${context.message}`);
    if (context.existingEntities && Object.keys(context.existingEntities).length > 0) {
      parts.push(`Classifier hints: ${JSON.stringify(context.existingEntities)}`);
    }
    // VOX-50: compact catalog table so the model prefers catalog names.
    const catalogSection = buildCatalogPromptSection(catalogItems);
    if (catalogSection) parts.push(catalogSection);
    return parts.join('\n');
  }
}

export { ESTIMATE_EDIT_SYSTEM_PROMPT, tryParseJson, buildPayload };
