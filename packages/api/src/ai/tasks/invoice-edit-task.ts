import { TaskHandler, TaskContext, TaskResult } from './task-handlers';
import { createProposal, CreateProposalInput } from '../../proposals/proposal';
import { LLMGateway } from '../gateway/gateway';
import { assessConfidence } from '../guardrails/confidence';
import type { CatalogItem, CatalogItemRepository } from '../../catalog/catalog-item';
import {
  buildCatalogPromptSection,
  resolveSpokenLineItems,
  CATALOG_PROMPT_ITEM_CAP,
} from './catalog-resolution';

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
 * P22-001 — post-process LLM edit actions through catalog resolution.
 *
 * For every `add_line_item` / `update_line_item` action:
 * - resolved against exactly one catalog item → the catalog's
 *   `unitPriceCents` OVERWRITES the LLM's price (never trust LLM
 *   prices), and `catalogItemId` is stamped on the line item.
 * - unresolved (not in catalog, or ambiguous) → LLM text kept,
 *   `unitPriceCents: null`, flagged `needsPricing: true` so the
 *   approval UI highlights it. Never guessed.
 *
 * Empty catalog → payload returned untouched (current free-text
 * behavior). Additive fields only, so the update_invoice Zod contract
 * (which requires `unitPrice`) still validates.
 */
function applyCatalogPricingToEditActions(
  payload: Record<string, unknown>,
  catalogItems: CatalogItem[],
): Record<string, unknown> {
  if (catalogItems.length === 0) return payload;
  if (!Array.isArray(payload.editActions)) return payload;

  const editActions = (payload.editActions as Array<Record<string, unknown>>).map((action) => {
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

    const { resolved } = resolveSpokenLineItems(
      [{ description, ...(quantity !== undefined ? { quantity } : {}) }],
      catalogItems,
    );

    if (resolved.length === 1) {
      const match = resolved[0];
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
          needsPricing: false,
        },
      };
    }

    // Unresolved: keep the LLM's text verbatim, never guess a catalog
    // price. `unitPrice` is left as-is (contract requires a number);
    // `unitPriceCents: null` + needsPricing flag the item for review.
    return {
      ...action,
      lineItem: {
        ...lineItem,
        unitPriceCents: null,
        needsPricing: true,
      },
    };
  });

  return { ...payload, editActions };
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
    const payload = applyCatalogPricingToEditActions(buildPayload(parsed), catalogItems);
    const confidence = assessConfidence(parsed ?? {});

    const input: CreateProposalInput = {
      tenantId: context.tenantId,
      proposalType: this.taskType,
      payload,
      summary: context.message,
      confidenceScore: confidence.score,
      confidenceFactors: confidence.factors,
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
  applyCatalogPricingToEditActions,
  CATALOG_PROMPT_ITEM_CAP,
};
