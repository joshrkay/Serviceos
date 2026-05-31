/**
 * In-memory dev fallback for the WebhookEvent idempotency repo.
 *
 * The Pg-backed variant (PgWebhookEventRepository, P0-020) sits on top of the
 * `webhook_events` table. There is no shared interface declaration in the
 * webhook-event source (only the Pg class), and per the P0-023 hard rules we
 * cannot edit any pg-* source file. To keep the `pool ? Pg : InMemory`
 * wiring pattern consistent across all six newly wired entities, a minimal
 * Map-backed stub lives here. It mirrors PgWebhookEventRepository's public
 * surface (recordReceipt / markProcessed / markFailed / findById /
 * findUnprocessed) so dev runs without DATABASE_URL still type-check.
 *
 * Production and staging ALWAYS use the Pg variant — `createApp()` throws
 * if DATABASE_URL is missing in those environments. So this stub is a
 * dev-only fallback by construction.
 *
 * Extracted from app.ts (composition-root decomposition) so the application
 * factory no longer carries an inline repository class.
 */

interface WebhookEventRecord {
  id: string;
  provider: string;
  eventId: string;
  eventType: string;
  payload: Record<string, unknown>;
  receivedAt: Date;
  processedAt: Date | null;
  processingError: string | null;
}

export class InMemoryWebhookEventRepository {
  private events = new Map<string, WebhookEventRecord>();

  private key(provider: string, eventId: string): string {
    return `${provider}:${eventId}`;
  }

  async recordReceipt(
    provider: string,
    eventId: string,
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<{ inserted: boolean; record: WebhookEventRecord }> {
    if (!provider) throw new Error('provider is required');
    if (!eventId) throw new Error('eventId is required');
    const k = this.key(provider, eventId);
    const existing = this.events.get(k);
    if (existing) {
      return { inserted: false, record: { ...existing } };
    }
    const record: WebhookEventRecord = {
      id: `${k}:${this.events.size + 1}`,
      provider,
      eventId,
      eventType,
      payload,
      receivedAt: new Date(),
      processedAt: null,
      processingError: null,
    };
    this.events.set(k, record);
    return { inserted: true, record: { ...record } };
  }

  async markProcessed(provider: string, eventId: string): Promise<void> {
    const r = this.events.get(this.key(provider, eventId));
    if (r) {
      r.processedAt = new Date();
      r.processingError = null;
    }
  }

  async markFailed(provider: string, eventId: string, error: string): Promise<void> {
    const r = this.events.get(this.key(provider, eventId));
    if (r) {
      r.processingError = error;
    }
  }

  async findById(provider: string, eventId: string) {
    const r = this.events.get(this.key(provider, eventId));
    return r ? { ...r } : null;
  }

  async findUnprocessed(limit = 100) {
    return Array.from(this.events.values())
      .filter((r) => r.processedAt === null && r.processingError === null)
      .sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime())
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }
}
