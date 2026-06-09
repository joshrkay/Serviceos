import { z } from 'zod';
import { CONVERSATION_CHANNELS } from '@rivet/contracts';
import { defineCommand, type CommandCtx } from '../../core/commands';

async function upsertConversation(
  ctx: CommandCtx,
  channel: (typeof CONVERSATION_CHANNELS)[number],
  externalNumber: string,
): Promise<string> {
  const { rows } = await ctx.client.query<{ id: string }>(
    `INSERT INTO conversations (tenant_id, channel, external_number, last_message_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (tenant_id, channel, external_number)
     DO UPDATE SET last_message_at = now()
     RETURNING id`,
    [ctx.tenantId, channel, externalNumber],
  );
  return rows[0]!.id;
}

export const recordInboundMessageCommand = defineCommand({
  name: 'comms.record_inbound_message',
  input: z.object({
    channel: z.enum(CONVERSATION_CHANNELS),
    from: z.string().min(1),
    to: z.string().min(1),
    body: z.string().min(1).max(10_000),
    externalId: z.string().max(200).optional(),
  }),
  async run(ctx, input): Promise<{ messageId: string; conversationId: string; duplicate: boolean }> {
    const conversationId = await upsertConversation(ctx, input.channel, input.from);
    const { rows } = await ctx.client.query<{ id: string }>(
      `INSERT INTO messages (tenant_id, conversation_id, direction, body, from_number, to_number, external_id)
       VALUES ($1, $2, 'inbound', $3, $4, $5, $6)
       ON CONFLICT (tenant_id, external_id) WHERE external_id IS NOT NULL DO NOTHING
       RETURNING id`,
      [ctx.tenantId, conversationId, input.body, input.from, input.to, input.externalId ?? null],
    );
    if (!rows[0]) {
      // Webhook redelivery: the message already exists.
      const existing = await ctx.client.query<{ id: string }>(
        `SELECT id FROM messages WHERE tenant_id = $1 AND external_id = $2`,
        [ctx.tenantId, input.externalId],
      );
      return { messageId: existing.rows[0]!.id, conversationId, duplicate: true };
    }
    // Events carry ids only — message bodies stay in the messages table.
    ctx.emit({
      eventType: 'message.received',
      entityType: 'message',
      entityId: rows[0].id,
      payload: { channel: input.channel, conversationId },
    });
    return { messageId: rows[0].id, conversationId, duplicate: false };
  },
});

export const recordOutboundMessageCommand = defineCommand({
  name: 'comms.record_outbound_message',
  input: z.object({
    channel: z.enum(CONVERSATION_CHANNELS),
    to: z.string().min(1),
    from: z.string().min(1),
    body: z.string().min(1).max(10_000),
    externalId: z.string().max(200).nullable(),
  }),
  async run(ctx, input): Promise<{ messageId: string }> {
    const conversationId = await upsertConversation(ctx, input.channel, input.to);
    const { rows } = await ctx.client.query<{ id: string }>(
      `INSERT INTO messages (tenant_id, conversation_id, direction, body, from_number, to_number, external_id)
       VALUES ($1, $2, 'outbound', $3, $4, $5, $6)
       RETURNING id`,
      [ctx.tenantId, conversationId, input.body, input.from, input.to, input.externalId],
    );
    ctx.emit({
      eventType: 'message.sent',
      entityType: 'message',
      entityId: rows[0]!.id,
      payload: { channel: input.channel, conversationId },
    });
    return { messageId: rows[0]!.id };
  },
});
