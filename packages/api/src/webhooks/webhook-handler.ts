import * as crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';

export interface WebhookEvent {
  id: string;
  source: string;
  eventType: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  status: 'received' | 'processing' | 'processed' | 'failed';
  errorMessage?: string;
  processedAt?: Date;
  createdAt: Date;
}

export interface WebhookConfig {
  signingSecret: string;
  toleranceSeconds?: number;
}

export interface WebhookRepository {
  findByIdempotencyKey(source: string, idempotencyKey: string): Promise<WebhookEvent | null>;
  create(event: WebhookEvent): Promise<WebhookEvent>;
  updateStatus(id: string, status: WebhookEvent['status'], error?: string): Promise<void>;
}

export function verifyWebhookSignature(
  payload: string,
  signature: string,
  secret: string,
  toleranceSeconds: number = 300
): boolean {
  if (!payload || !signature || !secret) return false;

  const parts = signature.split(',');
  const timestampPart = parts.find((p) => p.startsWith('t='));
  const signaturePart = parts.find((p) => p.startsWith('v1='));

  if (!timestampPart || !signaturePart) return false;

  const timestamp = parseInt(timestampPart.substring(2), 10);
  if (isNaN(timestamp)) return false;

  const providedSig = signaturePart.substring(3);
  if (!providedSig) return false;

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > toleranceSeconds) return false;

  const expectedSig = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${payload}`)
    .digest('hex');

  try {
    const providedBuf = Buffer.from(providedSig, 'hex');
    const expectedBuf = Buffer.from(expectedSig, 'hex');
    if (providedBuf.length !== expectedBuf.length) return false;
    return crypto.timingSafeEqual(providedBuf, expectedBuf);
  } catch {
    return false;
  }
}

export function createWebhookSignature(payload: string, secret: string, timestamp?: number): string {
  const ts = timestamp || Math.floor(Date.now() / 1000);
  const sig = crypto
    .createHmac('sha256', secret)
    .update(`${ts}.${payload}`)
    .digest('hex');
  return `t=${ts},v1=${sig}`;
}

/**
 * In-flight staleness threshold (ms). A `received` or `processing`
 * webhook row whose `createdAt` is within this window is treated as a
 * concurrent in-flight delivery and short-circuited as duplicate=true.
 * Older rows are assumed to be from a crashed handler that died before
 * marking the row 'failed' — retries are allowed to recover.
 *
 * 30 seconds covers our actual handler latencies (typically <5s for
 * checkout.session.completed, <1s for charge.refunded) with a generous
 * safety margin. Stripe's standard exponential-backoff retry cadence
 * starts at ~1 hour so a real Stripe retry will never fall inside this
 * window; the window only matters for manual retries from the Stripe
 * dashboard or concurrent network-glitch redeliveries.
 */
const INFLIGHT_STALENESS_MS = 30_000;

/**
 * Status-based dedup decision for an existing webhook row, shared by the
 * up-front findByIdempotencyKey path and the create-conflict (lost-race)
 * path so the two cannot diverge:
 *
 *   processed              → duplicate (handler ran cleanly).
 *   failed                 → not duplicate (retry to reconcile).
 *   processing | received  → duplicate iff still in-flight
 *                            (age < INFLIGHT_STALENESS_MS); a stale row is
 *                            a crashed handler, so allow the retry.
 */
function classifyExisting(existing: WebhookEvent): { event: WebhookEvent; duplicate: boolean } {
  if (existing.status === 'processed') {
    return { event: existing, duplicate: true };
  }
  if (existing.status === 'failed') {
    return { event: existing, duplicate: false };
  }
  const ageMs = Date.now() - existing.createdAt.getTime();
  return { event: existing, duplicate: ageMs < INFLIGHT_STALENESS_MS };
}

export async function handleWebhookEvent(
  source: string,
  eventType: string,
  payload: Record<string, unknown>,
  idempotencyKey: string,
  repository: WebhookRepository
): Promise<{ event: WebhookEvent; duplicate: boolean }> {
  // Codex P1 (PR #384) — dedup semantics for the four `status` values:
  //
  //   processed → duplicate=true (handler ran cleanly; no re-run).
  //
  //   processing | received, age < INFLIGHT_STALENESS_MS
  //               → duplicate=true (in-flight; concurrent delivery
  //                 would double-apply non-idempotent side effects
  //                 like deposit crediting).
  //
  //   processing | received, age ≥ INFLIGHT_STALENESS_MS
  //               → duplicate=false (handler crashed before flipping
  //                 status; let the retry recover).
  //
  //   failed     → duplicate=false (handler threw cleanly; retry to
  //                 reconcile, e.g. charge.refunded arriving before
  //                 checkout.session.completed).
  //
  // Returning the existing row (instead of creating a new one) keeps
  // the original event.id stable so audit / observability correlates
  // retries.
  const existing = await repository.findByIdempotencyKey(source, idempotencyKey);
  if (existing) {
    return classifyExisting(existing);
  }

  const event: WebhookEvent = {
    id: uuidv4(),
    source,
    eventType,
    idempotencyKey,
    payload,
    status: 'received',
    createdAt: new Date(),
  };

  const created = await repository.create(event);

  // Concurrency guard. A durable repository inserts with ON CONFLICT DO
  // NOTHING and, when our row loses the (source, idempotency_key) race,
  // returns the PRE-EXISTING row instead — which has a different id. The
  // up-front findByIdempotencyKey above can miss a row that another
  // delivery is inserting concurrently, so this is the second line of
  // defense: if create handed us back a row we didn't author, fall back
  // to the same status-based dedup we apply to a row found up front.
  // (The in-memory repo always returns the row we passed, so id matches
  // and this branch is a no-op there.)
  if (created.id !== event.id) {
    return classifyExisting(created);
  }

  return { event: created, duplicate: false };
}

export class InMemoryWebhookRepository implements WebhookRepository {
  private events: Map<string, WebhookEvent> = new Map();

  async findByIdempotencyKey(source: string, idempotencyKey: string): Promise<WebhookEvent | null> {
    for (const event of this.events.values()) {
      if (event.source === source && event.idempotencyKey === idempotencyKey) {
        return { ...event };
      }
    }
    return null;
  }

  async create(event: WebhookEvent): Promise<WebhookEvent> {
    this.events.set(event.id, { ...event });
    return event;
  }

  async updateStatus(id: string, status: WebhookEvent['status'], error?: string): Promise<void> {
    const event = this.events.get(id);
    if (event) {
      event.status = status;
      if (error) event.errorMessage = error;
      if (status === 'processed') event.processedAt = new Date();
    }
  }
}
