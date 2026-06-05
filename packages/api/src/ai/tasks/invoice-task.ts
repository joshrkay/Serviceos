import { TaskHandler, TaskContext, TaskResult } from './task-handlers';
import { createProposal, CreateProposalInput, Proposal } from '../../proposals/proposal';
import { LLMGateway } from '../gateway/gateway';
import { assessConfidence } from '../guardrails/confidence';

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

export class InvoiceTaskHandler implements TaskHandler {
  readonly taskType = 'draft_invoice' as const;
  private readonly gateway: LLMGateway;

  constructor(gateway: LLMGateway) {
    this.gateway = gateway;
  }

  async handle(context: TaskContext): Promise<TaskResult> {
    const userMessage = this.buildUserMessage(context);

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
          const unitPriceCents = Number(li.unitPriceCents ?? li.unitPrice);
          if (!Number.isFinite(unitPriceCents) || unitPriceCents < 0) return undefined;
          const totalCents = Math.round(unitPriceCents * qty);
          return {
            id: typeof li.id === 'string' ? li.id : `li-${idx + 1}`,
            description: typeof li.description === 'string' ? li.description : 'Service',
            category: typeof li.category === 'string' ? li.category.toLowerCase() : 'labor',
            quantity: qty,
            unitPriceCents: Math.round(unitPriceCents),
            totalCents,
            sortOrder: idx,
            taxable: typeof li.taxable === 'boolean' ? li.taxable : false,
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
    };

    const proposal = createProposal(input);
    return { proposal, taskType: this.taskType };
  }

  private buildUserMessage(context: TaskContext): string {
    const parts: string[] = [];
    parts.push(`Request: ${context.message}`);
    if (context.existingEntities && Object.keys(context.existingEntities).length > 0) {
      parts.push(`Context entities: ${JSON.stringify(context.existingEntities)}`);
    }
    return parts.join('\n');
  }
}

// Export helpers for testing
export { tryParseInvoiceJson, buildPartialInvoicePayload, INVOICE_SYSTEM_PROMPT };
