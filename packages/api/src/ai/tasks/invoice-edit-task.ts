import { TaskHandler, TaskContext, TaskResult } from './task-handlers';
import { createProposal, CreateProposalInput } from '../../proposals/proposal';
import { LLMGateway } from '../gateway/gateway';
import { assessConfidence } from '../guardrails/confidence';

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

export class InvoiceEditTaskHandler implements TaskHandler {
  readonly taskType = 'update_invoice' as const;
  private readonly gateway: LLMGateway;

  constructor(gateway: LLMGateway) {
    this.gateway = gateway;
  }

  async handle(context: TaskContext): Promise<TaskResult> {
    const llmResponse = await this.gateway.complete({
      taskType: 'update_invoice',
      messages: [
        { role: 'system', content: INVOICE_EDIT_SYSTEM_PROMPT },
        { role: 'user', content: this.buildUserMessage(context) },
      ],
      responseFormat: 'json',
    });

    const parsed = tryParseJson(llmResponse.content);
    const payload = buildPayload(parsed);
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
    };

    return { proposal: createProposal(input), taskType: this.taskType };
  }

  private buildUserMessage(context: TaskContext): string {
    const parts: string[] = [];
    parts.push(`Transcript: ${context.message}`);
    if (context.existingEntities && Object.keys(context.existingEntities).length > 0) {
      parts.push(`Classifier hints: ${JSON.stringify(context.existingEntities)}`);
    }
    return parts.join('\n');
  }
}

export { INVOICE_EDIT_SYSTEM_PROMPT, tryParseJson, buildPayload };
