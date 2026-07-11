import { TaskHandler, TaskContext, TaskResult } from './task-handlers';
import { createProposal, CreateProposalInput } from '../../proposals/proposal';
import { LLMGateway } from '../gateway/gateway';
import { assessConfidence, getConfidenceLevel } from '../guardrails/confidence';
import type { ConfidenceLevel } from '../guardrails/confidence';
import type { ProposalConfidenceMeta } from '../../proposals/contracts';
import type { CatalogItem, CatalogItemRepository } from '../../catalog/catalog-item';
import {
  buildCatalogPromptSection,
  resolveSpokenLineItems,
  CATALOG_PROMPT_ITEM_CAP,
} from './catalog-resolution';
import { UNCATALOGUED_CONFIDENCE_CAP } from '../resolution/catalog-resolver';

/**
 * InvoiceEditTaskHandler — produces `update_invoice` proposals from
 * voice transcripts like:
 *   "Add a water heater install for $850 to invoice INV-0042"
 *   "Remove the diagnostic from the Smith invoice"
 *   "Add a trip fee and remove the filter from INV-0042"
 *
 * The LLM returns an `invoiceReference` (a string the operator / review
 * UI resolves to a real invoice id) plus a list of edit actions. The
 * actual invoice-id resolution happens when the operator approves the
 * proposal: the reviewer confirms (or corrects) which invoice this
 * targets. Until then the payload carries the reference verbatim.
 *
 * Structural shape matches what applyInvoiceEdits consumes in
 * invoices/invoice-editor.ts. The execution handler validates the
 * resolved invoice id, then delegates to the pure editor.
 */

const INVOICE_EDIT_SYSTEM_PROMPT = `You edit draft invoices for a field service operating system.
Given a voice transcript from an operator, extract (1) which invoice they want
to change and (2) what changes they want applied.

Return valid JSON only (no prose, no markdown fences):
{
  "invoiceReference": "<string — invoice number, customer name, or whatever the operator said>",
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
      "description": "<short phrase matching the line-item description, e.g. 'diagnostic'>"
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
- unitPrice is ALWAYS integer cents. $850 → 85000. Never decimals.
- If the operator says "remove the plumbing repair", use type "remove_line_item"
  with description: "plumbing repair". The execution step will match it against
  the real line items in the invoice by description.
- If you can't identify either the invoice or a concrete edit, set confidence
  below 0.7. It's fine to return an editActions array that is empty if the
  transcript is truly ambiguous — don't fabricate.
- Never invent an invoice id or customer name. Use only what the transcript says.`;

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

  if (typeof parsed.invoiceReference === 'string') {
    payload.invoiceReference = parsed.invoiceReference;
  }

  if (Array.isArray(parsed.editActions)) {
    payload.editActions = parsed.editActions;
  } else {
    payload.editActions = [];
  }

  return payload;
}

/**
 * VOX-51 — post-process LLM edit actions through catalog resolution.
 *
 * Runs the SAME money-correctness contract as draft_invoice: an
 * AI-invented price must never be trusted into an auto-approvable
 * proposal. For every `add_line_item` / `update_line_item` action:
 * - resolved against exactly one catalog item → the catalog's
 *   `unitPriceCents` OVERWRITES the LLM's price (never trust LLM
 *   prices), and `catalogItemId` is stamped on the line item.
 * - unresolved (not in catalog, ambiguous, OR no catalog to ground
 *   against) → the LLM price is UNTRUSTED: flagged
 *   `pricingSource:'uncatalogued'` + `needsPricing:true`, `unitPriceCents`
 *   nulled, and the line drives `anyUncatalogued` so the handler caps
 *   confidence AND stamps `_meta.overallConfidence:'low'` (hard-blocks
 *   auto-approval). LLM text kept verbatim — never guessed.
 *
 * Empty catalog is NOT a short-circuit (that was the VOX-51 hole where a
 * new/empty-catalog tenant let an LLM-priced edit auto-approve): with no
 * catalog every priced line is uncatalogued, exactly like the draft
 * path's markAllUncatalogued. The executable `unitPrice` is left numeric
 * so the update_invoice Zod contract (which requires it) still
 * validates; it can never reach execution without a human first
 * reviewing the low-confidence proposal.
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
          // Catalog price ALWAYS overwrites the LLM's guess. `unitPrice`
          // (integer cents) is what the invoice editor executes;
          // `unitPriceCents` mirrors it for the approval UI.
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

export interface InvoiceEditTaskDeps {
  /**
   * Optional — when present, active catalog items are injected into the
   * LLM prompt and line items are post-priced from the catalog
   * (P22-001). When absent, behavior is identical to pre-P22.
   */
  catalogRepo?: CatalogItemRepository;
}

export class InvoiceEditTaskHandler implements TaskHandler {
  readonly taskType = 'update_invoice' as const;
  private readonly gateway: LLMGateway;
  private readonly deps: InvoiceEditTaskDeps;

  constructor(gateway: LLMGateway, deps: InvoiceEditTaskDeps = {}) {
    this.gateway = gateway;
    this.deps = deps;
  }

  /**
   * Fetch the tenant's active catalog. Best-effort: a catalog hiccup
   * degrades to the free-text path rather than failing the voice turn.
   * Tenant isolation rides on the repo's tenantId-first contract.
   */
  private async fetchCatalog(tenantId: string): Promise<CatalogItem[]> {
    if (!this.deps.catalogRepo) return [];
    try {
      const items = await this.deps.catalogRepo.listByTenant(tenantId);
      return items.filter((i) => i.archivedAt === null);
    } catch {
      return [];
    }
  }

  async handle(context: TaskContext): Promise<TaskResult> {
    const catalogItems = await this.fetchCatalog(context.tenantId);

    const llmResponse = await this.gateway.complete({
      taskType: 'update_invoice',
      messages: [
        { role: 'system', content: INVOICE_EDIT_SYSTEM_PROMPT },
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

    // VOX-51 — Confidence Marker `_meta`. Any ungrounded (LLM-priced) line
    // hard-blocks auto-approval via the RV-007 confidence-marker guard,
    // independent of the numeric score AND of any tenant
    // auto_approve_threshold override. An AI-invented edit price must always
    // reach a human.
    if (grounding.anyUncatalogued || grounding.anyCatalogPriced) {
      const meta: ProposalConfidenceMeta = {
        overallConfidence: grounding.anyUncatalogued
          ? 'low'
          : getConfidenceLevel(confidenceScore),
        ...(Object.keys(grounding.fieldConfidence).length > 0
          ? { fieldConfidence: grounding.fieldConfidence }
          : {}),
        ...(grounding.markers.length > 0 ? { markers: grounding.markers } : {}),
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
      // update_invoice touches an existing entity but the target is
      // still a draft (non-draft invoices are blocked at execute time).
      // Classified as `capture`, same as draft_invoice. The high
      // confidence threshold + operator review prevent surprise edits.
      sourceTrustTier: 'autonomous',
      // PR B — propagate tenant override from context.
      ...(context.tenantThresholdOverride
        ? { tenantThresholdOverride: context.tenantThresholdOverride }
        : {}),
      // Phase 12 — forward supervisor presence so this autonomous edit only
      // auto-approves when a supervisor is present (same gate as create_appointment).
      ...(context.supervisorPresent !== undefined
        ? { supervisorPresent: context.supervisorPresent }
        : {}),
      ...(context.supervisorMode ? { supervisorMode: context.supervisorMode } : {}),
    };

    return { proposal: createProposal(input), taskType: this.taskType };
  }

  private buildUserMessage(context: TaskContext, catalogItems: CatalogItem[] = []): string {
    const parts: string[] = [];
    parts.push(`Transcript: ${context.message}`);
    if (context.existingEntities && Object.keys(context.existingEntities).length > 0) {
      parts.push(`Classifier hints: ${JSON.stringify(context.existingEntities)}`);
    }
    // P22-001: compact catalog table (capped at CATALOG_PROMPT_ITEM_CAP).
    const catalogSection = buildCatalogPromptSection(catalogItems);
    if (catalogSection) parts.push(catalogSection);
    return parts.join('\n');
  }
}

export {
  INVOICE_EDIT_SYSTEM_PROMPT,
  tryParseJson,
  buildPayload,
  groundEditActionPricing,
  CATALOG_PROMPT_ITEM_CAP,
};
