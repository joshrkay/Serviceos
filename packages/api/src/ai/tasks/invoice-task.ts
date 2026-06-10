import { TaskHandler, TaskContext, TaskResult } from './task-handlers';
import { createProposal, CreateProposalInput, Proposal } from '../../proposals/proposal';
import { LLMGateway } from '../gateway/gateway';
import { assessConfidence } from '../guardrails/confidence';
import type { CatalogItem, CatalogItemRepository } from '../../catalog/catalog-item';
import { buildCatalogPromptSection, resolveSpokenLineItems } from './catalog-resolution';
import { calculateLineItemTotal } from '../../shared/billing-engine';

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

interface InvoicePayload {
  customerId?: string;
  jobId?: string;
  estimateId?: string;
  lineItems?: Array<{
    description: string;
    quantity: number;
    unitPrice: number;
    category?: string;
  }>;
  discountCents?: number;
  taxRateBps?: number;
  customerMessage?: string;
  internalNotes?: string;
}

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
  private readonly deps: InvoiceTaskDeps;

  constructor(gateway: LLMGateway, deps: InvoiceTaskDeps = {}) {
    this.gateway = gateway;
    this.deps = deps;
  }

  /** Best-effort tenant-scoped catalog fetch; failures degrade to []. */
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
    const userMessage = this.buildUserMessage(context, catalogItems);

    const llmResponse = await this.gateway.complete({
      taskType: 'draft_invoice',
      messages: [
        { role: 'system', content: INVOICE_SYSTEM_PROMPT },
        { role: 'user', content: userMessage },
      ],
      responseFormat: 'json',
    });

    const parsed = tryParseInvoiceJson(llmResponse.content);
    const payload = buildPartialInvoicePayload(parsed);
    // QA-2026-06-05: normalize line items to the execution contract — the
    // LLM emits `unitPrice` (cents per the system prompt) while the executor
    // reads `unitPriceCents`; the mismatch produced NaN money casts in live
    // executions. Non-finite amounts are dropped (they surface as missing
    // fields for operator review instead of doomed executions). Entity-id
    // trust is enforced at the entry points that accept free text (the
    // assistant route) — pipeline callers feed verified context ids.
    if (Array.isArray(payload.lineItems)) {
      payload.lineItems = (payload.lineItems as Array<Record<string, unknown>>)
        .map((li, idx) => {
          const qty = Number(li.quantity ?? 1) || 1;
          // P22-001: resolve against the tenant catalog FIRST — a
          // resolved item takes the catalog's exact integer-cents price,
          // never the LLM's guess. Single-unambiguous-match only;
          // ambiguous/unknown items fall through unresolved.
          const { resolved } = resolveSpokenLineItems(
            [{ description: typeof li.description === 'string' ? li.description : '', quantity: qty }],
            catalogItems,
          );
          const catalogMatch = resolved.length === 1 ? resolved[0] : undefined;
          const unitPriceCents = catalogMatch
            ? catalogMatch.unitPriceCents
            : Number(li.unitPriceCents ?? li.unitPrice);
          if (!Number.isFinite(unitPriceCents) || unitPriceCents < 0) return undefined;
          // Totals via the shared billing engine — never hand-rolled.
          const totalCents = calculateLineItemTotal(qty, unitPriceCents);
          return {
            id: typeof li.id === 'string' ? li.id : `li-${idx + 1}`,
            description: catalogMatch
              ? catalogMatch.description
              : typeof li.description === 'string'
                ? li.description
                : 'Service',
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
            unitPriceCents: Math.round(unitPriceCents),
            totalCents,
            sortOrder: idx,
            taxable: typeof li.taxable === 'boolean' ? li.taxable : false,
            // P22-001 flags: stamp catalog provenance on resolved items;
            // with a non-empty catalog, unresolved items are flagged so
            // the approval UI highlights them for pricing review.
            ...(catalogMatch ? { catalogItemId: catalogMatch.catalogItemId, needsPricing: false } : {}),
            ...(!catalogMatch && catalogItems.length > 0 ? { needsPricing: true } : {}),
          };
        })
        .filter(Boolean);
    }

    const confidenceInput = parsed ?? {};
    const confidence = assessConfidence(confidenceInput);

    const input: CreateProposalInput = {
      tenantId: context.tenantId,
      proposalType: this.taskType,
      payload,
      summary: context.message,
      confidenceScore: confidence.score,
      confidenceFactors: confidence.factors,
      sourceContext: context.conversationId ? { conversationId: context.conversationId } : undefined,
      createdBy: context.userId,
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
