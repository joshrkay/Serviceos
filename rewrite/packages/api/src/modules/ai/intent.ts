import { z } from 'zod';
import { PROPOSAL_TYPES, proposalPayloadSchemas } from '@rivet/contracts';
import type { CommandBus } from '../../core/commands';
import { withTenantTransaction, type Db } from '../../core/db';
import type { JobRunner } from '../../core/jobs';
import { createProposalCommand } from '../proposals/engine';
import type { LLMGateway } from './gateway';

const SYSTEM_PROMPT = `You are the intake brain for a home-services back office.
Given an inbound message, decide whether it implies one business action and
return STRICT JSON: {"type": <one of "create_customer" | "schedule_job" |
"draft_invoice" | "send_invoice" | null>, "payload": <object matching the
action contract>, "summary": <one human sentence>, "confidence": <0..1>}.
Return {"type": null} when no action is clear. Never invent prices or
customer details that are not in the message.
For schedule_job: set payload.startsAt (ISO 8601 UTC) to the caller's
requested time, resolving relative phrases ("tomorrow afternoon", "Friday
morning", "at 3pm") against NOW in TENANT_TIMEZONE; default to the next
morning at 9am when no time is given. Use the caller's stated name as
customerName when they introduce themselves.`;

const intentSchema = z.object({
  type: z.enum(PROPOSAL_TYPES).nullable(),
  payload: z.record(z.unknown()).optional(),
  summary: z.string().max(500).optional(),
  confidence: z.number().min(0).max(1).optional(),
});

const jobDataSchema = z.object({
  tenantId: z.string().uuid(),
  messageId: z.string().uuid(),
  source: z.enum(['sms', 'voice']),
});

interface IntentDeps {
  db: Db;
  bus: CommandBus;
  jobs: JobRunner;
  gateway: LLMGateway;
}

function parseJson(text: string): unknown {
  const cleaned = text.replace(/^```(?:json)?/m, '').replace(/```$/m, '').trim();
  return JSON.parse(cleaned);
}

/**
 * Turns an inbound message into a typed proposal (or nothing). The AI never
 * mutates state: its only output is a proposal awaiting human approval.
 * Idempotent per message via the proposal idempotency key.
 */
export function registerIntentExtractionWorker(deps: IntentDeps): Promise<void> {
  return deps.jobs.work('ai.extract-intent', async (raw) => {
    const { tenantId, messageId, source } = jobDataSchema.parse(raw);

    const context = await withTenantTransaction(deps.db, tenantId, async (client) => {
      const message = await client.query<{ body: string; from_number: string }>(
        `SELECT body, from_number FROM messages WHERE tenant_id = $1 AND id = $2`,
        [tenantId, messageId],
      );
      const customers = await client.query<{ name: string; phone: string }>(
        `SELECT name, phone FROM customers WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 20`,
        [tenantId],
      );
      const tenant = await client.query<{ timezone: string }>(
        `SELECT timezone FROM tenants WHERE id = $1`,
        [tenantId],
      );
      return {
        message: message.rows[0],
        customers: customers.rows,
        timezone: tenant.rows[0]?.timezone ?? 'America/New_York',
      };
    });
    if (!context.message) return;

    const prompt = [
      'KNOWN CUSTOMERS:',
      ...context.customers.map((c) => `- ${c.name} (${c.phone})`),
      '',
      `MESSAGE: ${context.message.body}`,
      `CALLER: ${context.message.from_number}`,
      `NOW: ${new Date().toISOString()}`,
      `TENANT_TIMEZONE: ${context.timezone}`,
    ].join('\n');

    const completion = await deps.gateway.run(
      { tenantId, correlationId: messageId },
      { taskType: 'intent_extraction', system: SYSTEM_PROMPT, prompt },
    );

    let intent: z.infer<typeof intentSchema>;
    try {
      intent = intentSchema.parse(parseJson(completion.text));
    } catch {
      intent = { type: null };
    }

    const scope = { tenantId, actor: { type: 'ai' as const, id: 'intent-extraction' }, correlationId: messageId };
    if (!intent.type) {
      await deps.bus.execute(recordUnrecognizedIntentCommand, scope, { messageId, source });
      return;
    }

    const payloadParse = proposalPayloadSchemas[intent.type].safeParse(intent.payload ?? {});
    if (!payloadParse.success) {
      await deps.bus.execute(recordUnrecognizedIntentCommand, scope, { messageId, source });
      return;
    }

    await deps.bus.execute(createProposalCommand, scope, {
      type: intent.type,
      source,
      payload: payloadParse.data,
      summary: intent.summary ?? `${intent.type} from inbound ${source}`,
      confidenceBps: intent.confidence !== undefined ? Math.round(intent.confidence * 10_000) : undefined,
      idempotencyKey: `intent:${messageId}`,
    });
  });
}

const recordUnrecognizedIntentCommand = {
  name: 'ai.record_unrecognized_intent',
  input: z.object({ messageId: z.string().uuid(), source: z.enum(['sms', 'voice']) }),
  async run(
    ctx: import('../../core/commands').CommandCtx,
    input: { messageId: string; source: 'sms' | 'voice' },
  ): Promise<void> {
    ctx.emit({
      eventType: 'ai.intent_unrecognized',
      entityType: 'message',
      entityId: input.messageId,
      payload: { source: input.source },
    });
  },
};
