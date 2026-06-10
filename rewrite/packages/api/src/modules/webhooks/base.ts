import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Db } from '../../core/db';

export interface WebhookIngestion {
  /** false when this external id was already ingested (redelivery). */
  fresh: boolean;
  webhookEventId: string | null;
}

/**
 * Webhook idempotency base: every inbound webhook is recorded once per
 * (provider, external_id) in the webhook_events ledger before any
 * processing. Redeliveries short-circuit.
 */
export async function ingestWebhook(
  db: Db,
  input: {
    provider: string;
    externalId: string;
    signatureValid: boolean;
    payload: unknown;
  },
): Promise<WebhookIngestion> {
  const { rows } = await db.admin.query<{ id: string }>(
    `INSERT INTO webhook_events (provider, external_id, signature_valid, payload)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (provider, external_id) DO NOTHING
     RETURNING id`,
    [input.provider, input.externalId, input.signatureValid, JSON.stringify(input.payload)],
  );
  return rows[0] ? { fresh: true, webhookEventId: rows[0].id } : { fresh: false, webhookEventId: null };
}

export async function markWebhookProcessed(
  db: Db,
  webhookEventId: string,
  outcome: { status: 'processed' | 'failed' | 'skipped'; error?: string },
): Promise<void> {
  await db.admin.query(
    `UPDATE webhook_events SET status = $2, error = $3, processed_at = now() WHERE id = $1`,
    [webhookEventId, outcome.status, outcome.error ?? null],
  );
}

export function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

/**
 * Stripe signature scheme: header `t=<ts>,v1=<hmac>` where hmac =
 * HMAC-SHA256(`${t}.${rawBody}`, secret). Tolerance guards replay.
 */
export function verifyStripeSignature(
  secret: string,
  rawBody: string,
  header: string,
  toleranceSeconds = 300,
  now: () => number = () => Date.now(),
): boolean {
  const parts = new Map(
    header.split(',').map((pair) => {
      const [key, ...rest] = pair.split('=');
      return [key ?? '', rest.join('=')] as const;
    }),
  );
  const timestamp = Number(parts.get('t'));
  const signature = parts.get('v1');
  if (!Number.isFinite(timestamp) || !signature) return false;
  if (Math.abs(now() / 1000 - timestamp) > toleranceSeconds) return false;
  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  return safeCompare(expected, signature);
}

/** Generic HMAC-SHA256 hex signature (used by the hosted voice provider webhook). */
export function verifyHmacSignature(secret: string, rawBody: string, signature: string): boolean {
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  return safeCompare(expected, signature);
}
