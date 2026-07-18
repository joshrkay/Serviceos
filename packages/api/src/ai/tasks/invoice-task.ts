import { TaskHandler, TaskContext, TaskResult } from './task-handlers';
import { createProposal, CreateProposalInput } from '../../proposals/proposal';
import { LLMGateway } from '../gateway/gateway';
import { assessConfidence, getConfidenceLevel } from '../guardrails/confidence';
import type { ProposalConfidenceMeta } from '../../proposals/contracts';
import type { CatalogItem, CatalogItemRepository } from '../../catalog/catalog-item';
import {
  CatalogPricingOutcome,
  groundLineItemPricing,
  lineItemConfidenceSignals,
  UNCATALOGUED_CONFIDENCE_CAP,
} from '../resolution/catalog-resolver';
import { buildCatalogPromptSection } from './catalog-resolution';
import {
  buildStandingInstructionsSection,
  intersectAppliedStandingInstructions,
} from '../standing-instructions-context';

const INVOICE_SYSTEM_PROMPT = `You are an invoice generation assistant for a field service company.
Given the job context, customer information, and completed work details, generate a structured invoice.
Return valid JSON with the following shape:
{
  "customerId": "<uuid>",
  "jobId": "<uuid>",
  "estimateId": "<uuid, optional>",
  "lineItems": [
    { "description": "<string>", "quantity": <number>, "unitPrice": <number>, "category": "<string, optional>" }
  ],
  "discountCents": <number, optional>,
  "taxRateBps": <number, optional>,
  "customerMessage": "<string, optional>",
  "internalNotes": "<string, optional>",
  "confidence_score": <number between 0 and 1>
}
Always include at least one line item. Ensure customerId and jobId are present.`;

function tryParseInvoiceJson(content: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(content);
    if (typeof parsed === 'object' && parsed !== null) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function buildPartialInvoicePayload(parsed: Record<string, unknown> | null): Record<string, unknown> {
  if (!parsed) {
    return { lineItems: [], notes: 'AI output could not be parsed' };
  }

  const payload: Record<string, unknown> = {};
  if (typeof parsed.customerId === 'string') payload.customerId = parsed.customerId;
  if (typeof parsed.jobId === 'string') payload.jobId = parsed.jobId;
  if (typeof parsed.estimateId === 'string') payload.estimateId = parsed.estimateId;
  if (Array.isArray(parsed.lineItems)) {
    payload.lineItems = parsed.lineItems;
  } else {
    payload.lineItems = [];
  }
  if (typeof parsed.discountCents === 'number') payload.discountCents = parsed.discountCents;
  if (typeof parsed.taxRateBps === 'number') payload.taxRateBps = parsed.taxRateBps;
  if (typeof parsed.customerMessage === 'string') payload.customerMessage = parsed.customerMessage;
  if (typeof parsed.internalNotes === 'string') payload.internalNotes = parsed.internalNotes;

  return payload;
}

/**
 * P22-001 — optional catalog context for draft_invoice. When wired,
 * the tenant's active catalog is injected into the LLM prompt and
 * resolved line items take the catalog's exact `unitPriceCents`
 * (overwriting any LLM guess). When absent: pre-P22 behavior.
 */
export interface InvoiceTaskDeps {
  catalogRepo?: CatalogItemRepository;
}

export class InvoiceTaskHandler implements TaskHandler {
  readonly taskType = 'draft_invoice' as const;
  private readonly gateway: LLMGateway;
  /**
   * P22 catalog grounding. When present, every drafted line item is
   * resolved against the tenant's active catalog and matched prices
   * OVERRIDE whatever the LLM emitted — money comes from the price
   * book, not the model. Optional so existing callers/tests keep the
   * pre-catalog behavior unchanged.
   */
  private readonly catalogRepo?: CatalogItemRepository;

  constructor(gateway: LLMGateway, deps?: CatalogItemRepository | InvoiceTaskDeps) {
    this.gateway = gateway;
    this.catalogRepo = deps && 'listByTenant' in deps ? deps : deps?.catalogRepo;
  }

  /**
   * Fetch active tenant catalog items for prompt grounding. Best-effort:
   * catalog outages should not block invoice drafting.
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
    const userMessage = this.buildUserMessage(context, catalogItems);

    // UB-A3 — owner standing instructions ride a SEPARATE, delimited system
    // message (mirroring the classifier's vertical-context injection) so the
    // base prompt stays byte-identical when none apply. Content-only: the
    // section itself forbids approval/confidence/schema/pricing overrides.
    const systemMessages: Array<{ role: 'system'; content: string }> = [
      { role: 'system', content: INVOICE_SYSTEM_PROMPT },
    ];
    const injectedInstructions = context.standingInstructions ?? [];
    if (injectedInstructions.length > 0) {
      systemMessages.push({
        role: 'system',
        content: buildStandingInstructionsSection(injectedInstructions, {
          requestAppliedIds: true,
        }),
      });
    }

    const llmResponse = await this.gateway.complete({
      taskType: 'draft_invoice',
      // Top-level tenantId so the gateway keys this tenant's concurrency
      // quota / cache bucket correctly (never the shared SYSTEM_TENANT_ID).
      tenantId: context.tenantId,
      messages: [...systemMessages, { role: 'user', content: userMessage }],
      responseFormat: 'json',
    });

    const parsed = tryParseInvoiceJson(llmResponse.content);
    const payload = buildPartialInvoicePayload(parsed);
    // QA-2026-06-05: normalize line items to the execution contract — the
    // LLM emits `unitPrice` (cents per the system prompt) while the executor
    // reads `unitPriceCents`; the mismatch produced NaN money casts in live
    // executions. Non-finite amounts are kept price-less here (catalog
    // resolution below can still price them) and dropped afterwards only
    // when no catalog price rescued them. Entity-id trust is enforced at
    // the entry points that accept free text (the assistant route) —
    // pipeline callers feed verified context ids.
    if (Array.isArray(payload.lineItems)) {
      payload.lineItems = (payload.lineItems as Array<Record<string, unknown>>).map((li, idx) => {
        const qty = Number(li.quantity ?? 1) || 1;
        const rawCents = Number(li.unitPriceCents ?? li.unitPrice);
        const unitPriceCents =
          Number.isFinite(rawCents) && rawCents >= 0 ? Math.round(rawCents) : undefined;
        return {
          id: typeof li.id === 'string' ? li.id : `li-${idx + 1}`,
          description: typeof li.description === 'string' ? li.description : 'Service',
          // DB CHECK allows labor/material/equipment/other — map the
          // LLM's vocabulary onto it, defaulting to 'other'.
          category: (() => {
            const c = typeof li.category === 'string' ? li.category.toLowerCase() : 'labor';
            if (['labor', 'material', 'equipment', 'other'].includes(c)) return c;
            if (['service', 'work', 'visit'].includes(c)) return 'labor';
            if (['parts', 'part', 'supplies'].includes(c)) return 'material';
            return 'other';
          })(),
          quantity: qty,
          ...(unitPriceCents !== undefined
            ? { unitPriceCents, totalCents: Math.round(unitPriceCents * qty) }
            : {}),
          sortOrder: idx,
          taxable: typeof li.taxable === 'boolean' ? li.taxable : false,
        };
      });
    }

    // P22 catalog grounding: resolve each drafted description against the
    // tenant's active catalog. Matched prices override the LLM's numbers;
    // ambiguous matches force 'draft' via missingFields; uncatalogued lines
    // keep the LLM price but cap confidence below auto-approve. A catalog
    // read failure must never block drafting — degrade to LLM pricing
    // (which the proposal gate still reviews).
    let catalogOutcome: CatalogPricingOutcome | undefined;
    const lineItems = payload.lineItems as Array<Record<string, unknown>>;
    if (Array.isArray(lineItems) && lineItems.length > 0) {
      // Always resolve to an outcome — even with no catalog wired, an empty
      // catalog, or a read error, every LLM price is treated as uncatalogued
      // so the confidence cap below still fires (previously an undefined
      // outcome silently skipped the cap for new/empty-catalog tenants).
      catalogOutcome = await groundLineItemPricing(
        lineItems,
        'unitPriceCents',
        this.catalogRepo ? () => this.catalogRepo!.listByTenant(context.tenantId) : null,
      );
      payload.lineItems = catalogOutcome.lineItems;
    }

    // Drop lines still lacking a valid price (LLM emitted garbage and the
    // catalog couldn't rescue them) — same terminal behavior as before
    // catalog grounding existed.
    if (Array.isArray(payload.lineItems)) {
      payload.lineItems = (payload.lineItems as Array<Record<string, unknown>>).filter(
        (li) => typeof li.unitPriceCents === 'number',
      );
    }

    const confidence = assessConfidence(parsed ?? {});
    let confidenceScore = confidence.score;
    const confidenceFactors = [...confidence.factors];
    if (catalogOutcome?.anyCatalogPriced) confidenceFactors.push('catalog_priced');
    if (catalogOutcome?.anyUncatalogued) {
      confidenceFactors.push('uncatalogued_line_item');
      // Money-correctness gate: an AI-invented price must never ride a
      // ≥0.9 confidence score into autonomous auto-approval.
      confidenceScore = Math.min(confidenceScore, UNCATALOGUED_CONFIDENCE_CAP);
    }

    // RV-007 — Confidence Marker `_meta`. Overall level is the mapped
    // task confidence (post-cap); per-field signals translate the
    // catalog resolver's pricingSource outcomes (uncatalogued/ambiguous
    // lines → 'low' + a marker). Computed from the FINAL line items —
    // after the drop-unpriced filter above — so the paths index the
    // stored payload. No new confidence computation.
    const signals = lineItemConfidenceSignals(
      Array.isArray(payload.lineItems)
        ? (payload.lineItems as Array<Record<string, unknown>>)
        : [],
      'unitPriceCents',
    );
    // UB-A3 — applied-instruction marker: the model's claimed ids are
    // INTERSECTED with what was injected (never trust invented ids) and the
    // field is dropped entirely when empty.
    const appliedStandingInstructions = intersectAppliedStandingInstructions(
      parsed?.appliedStandingInstructions,
      injectedInstructions,
    );
    const meta: ProposalConfidenceMeta = {
      // Hard-block auto-approval for any ungrounded (LLM-priced) line via the
      // RV-007 confidence-marker guard — independent of the numeric score AND
      // of any tenant `auto_approve_threshold` override (a threshold ≤ the 0.85
      // uncatalogued cap would otherwise still auto-approve an AI-invented
      // price). An uncatalogued price must always reach a human.
      // Deliberately `anyUncatalogued`, NOT `requiresReview`: ambiguous lines
      // are gated by `missingFields`, which one-tap resolution CLEARS — a
      // persisted 'low' stamp would keep blocking chain-set/SMS approval
      // after the ambiguity is resolved.
      overallConfidence: catalogOutcome?.anyUncatalogued
        ? 'low'
        : getConfidenceLevel(confidenceScore),
      ...(Object.keys(signals.fieldConfidence).length > 0
        ? { fieldConfidence: signals.fieldConfidence }
        : {}),
      ...(signals.markers.length > 0 ? { markers: signals.markers } : {}),
      ...(appliedStandingInstructions.length > 0 ? { appliedStandingInstructions } : {}),
    };
    payload._meta = meta;

    const sourceContext: Record<string, unknown> = {
      ...(context.conversationId ? { conversationId: context.conversationId } : {}),
      // Ambiguous-line candidates for the review UI's "pick the right
      // catalog item" prompt. Rides sourceContext (like missingFields)
      // so no schema migration is needed.
      ...(catalogOutcome?.catalogResolution
        ? { catalogResolution: catalogOutcome.catalogResolution }
        : {}),
    };

    const input: CreateProposalInput = {
      tenantId: context.tenantId,
      proposalType: this.taskType,
      payload,
      summary: context.message,
      confidenceScore,
      confidenceFactors,
      sourceContext: Object.keys(sourceContext).length > 0 ? sourceContext : undefined,
      createdBy: context.userId,
      // Ambiguous catalog matches require the operator to pick the item —
      // forces 'draft' regardless of trust tier / confidence.
      ...(catalogOutcome && catalogOutcome.missingFields.length > 0
        ? { missingFields: catalogOutcome.missingFields }
        : {}),
      // D3: draft_invoice is capture-class — drafting moves no money.
      // Sending an invoice is a separate proposal (and would be
      // money-class, gated). Passing the autonomous tier lets
      // decideInitialStatus auto-approve the DRAFT when confidence is
      // ≥ 0.9. Operator approval still required to issue/send.
      sourceTrustTier: 'autonomous',
      // PR B — propagate tenant override from context.
      ...(context.tenantThresholdOverride
        ? { tenantThresholdOverride: context.tenantThresholdOverride }
        : {}),
      // Phase 12 — forward supervisor presence so this autonomous draft only
      // auto-approves when a supervisor is present (same gate as create_appointment).
      ...(context.supervisorPresent !== undefined
        ? { supervisorPresent: context.supervisorPresent }
        : {}),
      ...(context.supervisorMode ? { supervisorMode: context.supervisorMode } : {}),
    };

    const proposal = createProposal(input);
    return { proposal, taskType: this.taskType };
  }

  private buildUserMessage(context: TaskContext, catalogItems: CatalogItem[] = []): string {
    const parts: string[] = [];
    parts.push(`Request: ${context.message}`);
    if (context.existingEntities && Object.keys(context.existingEntities).length > 0) {
      parts.push(`Context entities: ${JSON.stringify(context.existingEntities)}`);
    }
    // P22-001: compact catalog table (name | unit | price), capped at
    // 150 items with truncation noted in the section itself.
    const catalogSection = buildCatalogPromptSection(catalogItems);
    if (catalogSection) parts.push(catalogSection);
    return parts.join('\n');
  }
}

// Export helpers for testing
export { tryParseInvoiceJson, buildPartialInvoicePayload, INVOICE_SYSTEM_PROMPT };
