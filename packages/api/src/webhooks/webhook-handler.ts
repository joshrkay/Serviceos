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
  const providedSig = signaturePart.substring(3);

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > toleranceSeconds) return false;

  const expectedSig = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${payload}`)
    .digest('hex');

  return crypto.timingSafeEqual(
    Buffer.from(providedSig, 'hex'),
    Buffer.from(expectedSig, 'hex')
  );
}

export function createWebhookSignature(payload: string, secret: string, timestamp?: number): string {
  const ts = timestamp || Math.floor(Date.now() / 1000);
  const sig = crypto
    .createHmac('sha256', secret)
    .update(`${ts}.${payload}`)
    .digest('hex');
  return `t=${ts},v1=${sig}`;
}

export async function handleWebhookEvent(
  source: string,
  eventType: string,
  payload: Record<string, unknown>,
  idempotencyKey: string,
  repository: WebhookRepository
): Promise<{ event: WebhookEvent; duplicate: boolean }> {
  const existing = await repository.findByIdempotencyKey(source, idempotencyKey);
  if (existing) {
    return { event: existing, duplicate: true };
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

  await repository.create(event);
  return { event, duplicate: false };
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
