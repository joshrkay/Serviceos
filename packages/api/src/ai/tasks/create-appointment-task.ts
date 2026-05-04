import { TaskHandler, TaskContext, TaskResult } from './task-handlers';
import { createProposal, CreateProposalInput } from '../../proposals/proposal';
import { LLMGateway } from '../gateway/gateway';
import { assessConfidence } from '../guardrails/confidence';

/**
 * LLM-backed CreateAppointmentTaskHandler.
 *
 * Exists alongside the minimal CreateAppointmentTaskHandler in
 * `task-handlers.ts`. That one is for programmatic callers that already
 * have structured date/time fields. This one is for voice transcripts
 * where the operator says "next Tuesday at 2pm" and the LLM has to
 * turn that into an ISO datetime.
 *
 * Produces the same proposal type (`create_appointment`) so the
 * downstream CreateAppointmentExecutionHandler doesn't care which
 * task handler built the payload.
 */

const APPOINTMENT_SYSTEM_PROMPT = `You are an appointment scheduling assistant for a field service operating system.
Given a voice transcript from a field service operator, extract the appointment details.

Return valid JSON with this shape (no prose, no markdown fences):
{
  "customerName": "<string, optional>",
  "customerId": "<uuid, optional — only if explicitly known>",
  "jobId": "<uuid, optional — only if explicitly known>",
  "scheduledStart": "<ISO 8601 datetime, e.g. 2026-04-21T21:00:00Z>",
  "scheduledEnd": "<ISO 8601 datetime>",
  "summary": "<one-line description of the appointment>",
  "confidence_score": <number between 0 and 1>
}

Rules:
- Always return ISO 8601 UTC datetimes for scheduledStart and scheduledEnd.
- If the transcript says "next Tuesday at 2pm" assume the tenant's local
  timezone is America/Los_Angeles unless told otherwise, then convert to UTC.
- If no explicit end time is given, default the appointment to 1 hour.
- If the date is ambiguous, set confidence_score below 0.7.
- Never invent a customerId or jobId.`;

const ISO_DATETIME_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

function isIsoDatetime(v: unknown): v is string {
  return typeof v === 'string' && ISO_DATETIME_REGEX.test(v);
}

function tryParseJson(content: string): Record<string, unknown> | null {
  try {
    const p = JSON.parse(content);
    return typeof p === 'object' && p !== null ? (p as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function buildPayload(parsed: Record<string, unknown> | null): Record<string, unknown> {
  if (!parsed) return {};
  const payload: Record<string, unknown> = {};

  if (typeof parsed.customerName === 'string') payload.customerName = parsed.customerName;
  if (typeof parsed.customerId === 'string') payload.customerId = parsed.customerId;
  if (typeof parsed.jobId === 'string') payload.jobId = parsed.jobId;
  if (typeof parsed.summary === 'string') payload.summary = parsed.summary;

  // Strict ISO validation — refuse garbage dates rather than hand
  // them to the execution handler where they'd blow up at execute time.
  if (isIsoDatetime(parsed.scheduledStart)) payload.scheduledStart = parsed.scheduledStart;
  if (isIsoDatetime(parsed.scheduledEnd)) payload.scheduledEnd = parsed.scheduledEnd;

  return payload;
}

export class CreateAppointmentAITaskHandler implements TaskHandler {
  readonly taskType = 'create_appointment' as const;
  private readonly gateway: LLMGateway;

  constructor(gateway: LLMGateway) {
    this.gateway = gateway;
  }

  async handle(context: TaskContext): Promise<TaskResult> {
    const llmResponse = await this.gateway.complete({
      taskType: 'create_appointment',
      messages: [
        { role: 'system', content: APPOINTMENT_SYSTEM_PROMPT },
        { role: 'user', content: this.buildUserMessage(context) },
      ],
      responseFormat: 'json',
    });

    const parsed = tryParseJson(llmResponse.content);
    const payload = buildPayload(parsed);

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
      // Appointments are capture-class — schedule changes are reversible
      // and the undo window provides the human-in-the-loop check. See D3.
      sourceTrustTier: 'autonomous',
    };

    return { proposal: createProposal(input), taskType: this.taskType };
  }

  private buildUserMessage(context: TaskContext): string {
    const parts: string[] = [];
    parts.push(`Transcript: ${context.message}`);
    if (context.existingEntities && Object.keys(context.existingEntities).length > 0) {
      parts.push(`Known entities: ${JSON.stringify(context.existingEntities)}`);
    }
    return parts.join('\n');
  }
}

export { APPOINTMENT_SYSTEM_PROMPT, isIsoDatetime, buildPayload };
