import { TaskHandler, TaskContext, TaskResult } from './task-handlers';
import { createProposal, CreateProposalInput } from '../../proposals/proposal';
import { LLMGateway } from '../gateway/gateway';
import { assessConfidence, getConfidenceLevel } from '../guardrails/confidence';
import type { ProposalConfidenceMeta } from '../../proposals/contracts';
import type { Estimate, EstimateRepository } from '../../estimates/estimate';

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

  constructor(
    gateway: LLMGateway,
    estimateRepo?: Pick<EstimateRepository, 'findById' | 'findByTenant'>,
  ) {
    this.gateway = gateway;
    this.estimateRepo = estimateRepo;
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

    const target = await this.resolveTargetEstimate(context.tenantId, payload);
    if (target?.status === 'accepted') {
      const meta: ProposalConfidenceMeta = {
        overallConfidence: getConfidenceLevel(confidence.score),
        markers: [ACCEPTANCE_VOID_MARKER],
      };
      payload._meta = meta;
    }

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
