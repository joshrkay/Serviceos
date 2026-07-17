/**
 * UB-A2 (agent wave) — create_standing_instruction voice on-ramp.
 *
 * "From now on always add a $79 diagnostic fee to AC calls" → a
 * create_standing_instruction proposal whose payload matches
 * `createStandingInstructionPayloadSchema` ({ instruction, scope? }). The LLM
 * (routed through the gateway, like every sibling task) NORMALIZES the spoken
 * directive into a concise imperative and proposes a structured scope; the
 * result is validated with the domain scope schema and any transcript-derived
 * amount (extractedEntities.amount) OVERRIDES a model-emitted amountCents —
 * an LLM never invents money.
 *
 * v1 rule (per the plan): this handler NEVER passes sourceTrustTier, so even
 * though the type is capture-class the instruction itself always lands for
 * human review. Gateway/parse failures degrade to the verbatim transcript
 * text (deterministic), never a dropped utterance.
 */
import {
  MAX_INSTRUCTION_LENGTH,
  StandingInstructionScope,
  standingInstructionScopeSchema,
} from '../../instructions/standing-instructions';
import { createProposal, CreateProposalInput } from '../../proposals/proposal';
import { LLMGateway } from '../gateway/gateway';
import { ExtractedEntities } from '../orchestration/intent-classifier';
import { TaskContext, TaskHandler, TaskResult } from './task-handlers';

const STANDING_INSTRUCTION_SYSTEM_PROMPT = `You normalize a spoken standing instruction for a field-service business into a stored directive.

Given the operator's words, return valid JSON (no prose, no markdown fences):
{
  "instruction": "<concise imperative directive, faithful to the speaker, max ${MAX_INSTRUCTION_LENGTH} characters>",
  "scope": {
    "intents": ["<intent the rule applies to, e.g. create_invoice, draft_estimate, create_appointment — omit when the rule is general>"],
    "tradeCategories": ["<trade/service category named by the speaker, e.g. hvac, plumbing — omit when none>"],
    "customerSegment": "<new|existing|all — omit unless the speaker limited the rule to new or existing customers>",
    "amountCents": <integer cents when the rule carries a dollar amount, optional>
  }
}

Rules:
- Keep the speaker's meaning exactly; do not add policy they did not state.
- Omit "scope" entirely when the rule is unscoped.
- Never invent an amount; include amountCents only when the speaker said one.`;

export class CreateStandingInstructionTaskHandler implements TaskHandler {
  readonly taskType = 'create_standing_instruction' as const;

  constructor(private readonly gateway: LLMGateway) {}

  async handle(context: TaskContext): Promise<TaskResult> {
    const ee = (context.existingEntities ?? {}) as ExtractedEntities;
    const spoken =
      typeof ee.instructionText === 'string' && ee.instructionText.trim().length > 0
        ? ee.instructionText.trim()
        : context.message.trim();

    const normalized = await this.normalize(context, spoken, ee);

    const payload: Record<string, unknown> = {};
    const missing: string[] = [];

    const instruction = (normalized?.instruction ?? spoken).slice(0, MAX_INSTRUCTION_LENGTH).trim();
    if (instruction) payload.instruction = instruction;
    else missing.push('instruction');

    let scope: StandingInstructionScope | undefined = normalized?.scope;
    // Transcript-derived amount wins over anything the model emitted — the
    // classifier extracted it from the operator's own words.
    if (typeof ee.amount === 'number' && Number.isInteger(ee.amount) && ee.amount > 0) {
      scope = { ...(scope ?? {}), amountCents: ee.amount };
    }
    if (scope && Object.keys(scope).length > 0) payload.scope = scope;

    const input: CreateProposalInput = {
      tenantId: context.tenantId,
      proposalType: this.taskType,
      payload,
      summary: instruction
        ? `Standing instruction: ${instruction.length > 80 ? `${instruction.slice(0, 79)}…` : instruction}`
        : context.message,
      sourceContext: context.conversationId
        ? { conversationId: context.conversationId }
        : undefined,
      createdBy: context.userId,
      missingFields: missing.length > 0 ? missing : undefined,
      ...(context.tenantThresholdOverride
        ? { tenantThresholdOverride: context.tenantThresholdOverride }
        : {}),
      // v1 rule — sourceTrustTier is DELIBERATELY omitted: decideInitialStatus
      // lands the proposal in 'draft', so a standing instruction can never
      // auto-approve regardless of confidence or supervisor presence.
    };

    return { proposal: createProposal(input), taskType: this.taskType };
  }

  /**
   * LLM normalization pass. Failure-soft: any gateway error, JSON parse
   * failure, or scope that fails the domain schema degrades to undefined and
   * the handler falls back to the verbatim spoken text with no scope.
   */
  private async normalize(
    context: TaskContext,
    spoken: string,
    ee: ExtractedEntities,
  ): Promise<{ instruction?: string; scope?: StandingInstructionScope } | undefined> {
    try {
      const response = await this.gateway.complete({
        taskType: 'create_standing_instruction',
        // Top-level tenantId so the gateway keys this tenant's concurrency
        // quota / cache bucket correctly (never the shared SYSTEM_TENANT_ID).
        tenantId: context.tenantId,
        messages: [
          { role: 'system', content: STANDING_INSTRUCTION_SYSTEM_PROMPT },
          {
            role: 'user',
            content: JSON.stringify({
              instructionText: spoken,
              ...(ee.scopeIntentHint ? { scopeIntentHint: ee.scopeIntentHint } : {}),
              ...(typeof ee.amount === 'number' ? { amountCents: ee.amount } : {}),
            }),
          },
        ],
        responseFormat: 'json',
        metadata: { tenantId: context.tenantId },
      });

      const parsed = JSON.parse(response.content) as Record<string, unknown>;
      const instruction =
        typeof parsed.instruction === 'string' && parsed.instruction.trim().length > 0
          ? parsed.instruction.trim()
          : undefined;

      let scope: StandingInstructionScope | undefined;
      if (parsed.scope !== undefined) {
        const scopeResult = standingInstructionScopeSchema.safeParse(parsed.scope);
        // An invalid model-emitted scope is dropped (never persisted junk),
        // but a valid instruction text is still used.
        scope = scopeResult.success ? scopeResult.data : undefined;
      }

      return { instruction, scope };
    } catch {
      return undefined;
    }
  }
}
