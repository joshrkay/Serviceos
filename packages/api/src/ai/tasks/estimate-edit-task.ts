import { TaskHandler, TaskContext, TaskResult } from './task-handlers';
import { createProposal, CreateProposalInput } from '../../proposals/proposal';
import { LLMGateway } from '../gateway/gateway';
import { assessConfidence } from '../guardrails/confidence';

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

  if (Array.isArray(parsed.editActions)) {
    payload.editActions = parsed.editActions;
  } else {
    payload.editActions = [];
  }

  return payload;
}

export class EstimateEditTaskHandler implements TaskHandler {
  readonly taskType = 'update_estimate' as const;
  private readonly gateway: LLMGateway;

  constructor(gateway: LLMGateway) {
    this.gateway = gateway;
  }

  async handle(context: TaskContext): Promise<TaskResult> {
    const llmResponse = await this.gateway.complete({
      taskType: 'update_estimate',
      messages: [
        { role: 'system', content: ESTIMATE_EDIT_SYSTEM_PROMPT },
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

  private buildUserMessage(context: TaskContext): string {
    const parts: string[] = [];
    parts.push(`Transcript: ${context.message}`);
    if (context.existingEntities && Object.keys(context.existingEntities).length > 0) {
      parts.push(`Classifier hints: ${JSON.stringify(context.existingEntities)}`);
    }
    return parts.join('\n');
  }
}

export { ESTIMATE_EDIT_SYSTEM_PROMPT, tryParseJson, buildPayload };
