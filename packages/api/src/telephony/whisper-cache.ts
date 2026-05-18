/**
 * Short-TTL in-memory cache for Twilio whisper TwiML payloads.
 *
 * Twilio fetches the whisper webhook within seconds of dialing the
 * dispatcher. We keep entries alive for 5 minutes by default so a slow
 * carrier doesn't 404 us, and reap them on access or on expiry.
 *
 * NOTE: This is process-local. In a multi-instance deployment, sticky
 * sessions on the Twilio-facing routes are required, OR replace with a
 * Redis-backed implementation that conforms to the same interface.
 */

interface CacheEntry {
  text: string;
  expiresAt: number;
}

export interface WhisperCacheOptions {
  ttlMs?: number;
}

export class WhisperCache {
  private readonly ttlMs: number;
  private readonly entries = new Map<string, CacheEntry>();

  constructor(opts: WhisperCacheOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 5 * 60 * 1000;
  }

  set(escalationId: string, text: string): void {
    this.entries.set(escalationId, { text, expiresAt: Date.now() + this.ttlMs });
  }

  get(escalationId: string): string | undefined {
    const entry = this.entries.get(escalationId);
    if (!entry) return undefined;
    if (entry.expiresAt < Date.now()) {
      this.entries.delete(escalationId);
      return undefined;
    }
    return entry.text;
  }

  size(): number {
    return this.entries.size;
  }
}
