import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { defineCommand, CommandError, type CommandBus } from '../../core/commands';
import type { Db } from '../../core/db';
import { makeApproveProposalCommand, rejectProposalCommand } from '../proposals/engine';
import { recordInboundMessageCommand } from './messages';

/**
 * Twilio webhook signature: base64(HMAC-SHA1(url + sorted(key+value), authToken)).
 */
export function verifyTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
  signature: string,
): boolean {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  const expected = createHmac('sha1', authToken).update(data).digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

const APPROVAL_REPLY = /^\s*(yes|no)\s+(\d{1,6})\s*$/i;

export const processInboundSmsCommand = defineCommand({
  name: 'comms.process_inbound_sms',
  input: z.object({
    from: z.string().min(1),
    to: z.string().min(1),
    body: z.string().min(1).max(10_000),
    externalId: z.string().max(200).optional(),
  }),
  async run(ctx, input): Promise<{ messageId: string; duplicate: boolean; intentQueued: boolean }> {
    const recorded = await ctx.invoke(recordInboundMessageCommand, {
      channel: 'sms' as const,
      from: input.from,
      to: input.to,
      body: input.body,
      externalId: input.externalId,
    });
    if (recorded.duplicate) return { ...recorded, intentQueued: false };
    ctx.enqueue({
      topic: 'ai.extract-intent',
      payload: { messageId: recorded.messageId, source: 'sms' },
      dedupeKey: `extract-intent:${recorded.messageId}`,
    });
    return { ...recorded, intentQueued: true };
  },
});

export interface InboundSmsResult {
  reply: string | null;
}

interface InboundDeps {
  db: Db;
  bus: CommandBus;
  undoWindowSeconds: number;
}

/**
 * Inbound SMS router. Owner replies "YES n" / "NO n" drive the approval
 * loop; everything else is recorded and handed to intent extraction.
 * Tenant resolution by the receiving number is a platform concern (admin
 * pool) — it happens before tenant context exists.
 */
export async function handleInboundSms(
  deps: InboundDeps,
  input: { from: string; to: string; body: string; externalId?: string },
): Promise<InboundSmsResult | null> {
  const tenant = await deps.db.admin.query<{ id: string }>(
    `SELECT id FROM tenants WHERE phone = $1`,
    [input.to],
  );
  const tenantId = tenant.rows[0]?.id;
  if (!tenantId) return null;

  const owner = await deps.db.admin.query<{ id: string }>(
    `SELECT id FROM users WHERE tenant_id = $1 AND role = 'owner' AND phone = $2`,
    [tenantId, input.from],
  );
  const ownerId = owner.rows[0]?.id;

  const approvalMatch = ownerId ? APPROVAL_REPLY.exec(input.body) : null;
  if (ownerId && approvalMatch) {
    const decision = approvalMatch[1]!.toLowerCase();
    const shortCode = Number(approvalMatch[2]);
    const scope = { tenantId, actor: { type: 'user' as const, id: ownerId } };
    try {
      if (decision === 'yes') {
        const approved = await deps.bus.execute(
          makeApproveProposalCommand(deps.undoWindowSeconds),
          scope,
          { shortCode },
        );
        return { reply: `Approved #${shortCode}: ${approved.summary}` };
      }
      const rejected = await deps.bus.execute(rejectProposalCommand, scope, { shortCode });
      return { reply: `Rejected #${shortCode}: ${rejected.summary}` };
    } catch (err) {
      if (err instanceof CommandError) {
        return { reply: `Couldn't ${decision === 'yes' ? 'approve' : 'reject'} #${shortCode} — it may already be handled.` };
      }
      throw err;
    }
  }

  await deps.bus.execute(
    processInboundSmsCommand,
    { tenantId, actor: { type: 'system', id: 'sms-inbound' } },
    input,
  );
  return { reply: ownerId ? null : "Thanks — we got your message and we'll text you back shortly." };
}
