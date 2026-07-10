/**
 * Tiny in-memory LRU used to make webhook processing idempotent by event id.
 * Preview-scoped only — a real deployment would back this with Redis/DB. When
 * an id has already been seen, the webhook handler skips re-running side effects.
 */

export class LruSet {
  private readonly max: number;
  private readonly map = new Map<string, true>();

  constructor(max = 1000) {
    this.max = max;
  }

  /** Returns true if this id was already seen; otherwise records it and returns false. */
  seen(id: string): boolean {
    if (this.map.has(id)) {
      // refresh recency
      this.map.delete(id);
      this.map.set(id, true);
      return true;
    }
    this.map.set(id, true);
    if (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    return false;
  }

  get size(): number {
    return this.map.size;
  }
}

// Module-level singleton so it survives across requests within a warm instance.
export const processedWebhookEvents = new LruSet(2000);
