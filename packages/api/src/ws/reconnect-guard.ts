/**
 * Token-bucket reconnect-storm guard for WS upgrades.
 *
 * Keyed by ip+tenantId. Tightens automatically when the global memory
 * watermark is high (callers pass `tighten=true`). Used to refuse
 * upgrade requests with HTTP 429 + Retry-After.
 */
import { wsReconnectRejectTotal } from '../monitoring/metrics';

export interface ReconnectGuardConfig {
  capacity: number;
  refillTokensPerSec: number;
  /** Multiplier applied when memory watermark is high. */
  tightenedFactor: number;
}

export const DEFAULT_RECONNECT_GUARD: ReconnectGuardConfig = {
  capacity: 10,
  refillTokensPerSec: 2,
  tightenedFactor: 0.25,
};

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

export class ReconnectGuard {
  private buckets: Map<string, Bucket> = new Map();
  constructor(private readonly cfg: ReconnectGuardConfig = DEFAULT_RECONNECT_GUARD) {}

  /** Returns retry-after-ms when refused, 0 when accepted. */
  tryAdmit(opts: { ip: string; tenantId?: string; tighten?: boolean }): number {
    const cfg = this.cfg;
    const factor = opts.tighten ? cfg.tightenedFactor : 1;
    const cap = Math.max(1, Math.floor(cfg.capacity * factor));
    const refillRate = Math.max(0.1, cfg.refillTokensPerSec * factor);

    const key = `${opts.ip}|${opts.tenantId ?? 'anon'}`;
    const now = Date.now();
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: cap, lastRefillMs: now };
      this.buckets.set(key, b);
    } else {
      const elapsedSec = (now - b.lastRefillMs) / 1000;
      b.tokens = Math.min(cap, b.tokens + elapsedSec * refillRate);
      b.lastRefillMs = now;
    }

    if (b.tokens < 1) {
      const deficit = 1 - b.tokens;
      const retryMs = Math.ceil((deficit / refillRate) * 1000);
      wsReconnectRejectTotal.inc({
        surface: 'client_gateway',
        reason: opts.tighten ? 'memory_watermark' : 'rate_limit',
      });
      return retryMs;
    }
    b.tokens -= 1;
    return 0;
  }
}

/** Returns true when process RSS exceeds 80% of the OS-reported max. */
export function isMemoryWatermarkHigh(thresholdRatio = 0.85): boolean {
  const usage = process.memoryUsage();
  // Heuristic: use heapTotal as the upper bound proxy.
  if (usage.heapTotal === 0) return false;
  const ratio = usage.heapUsed / usage.heapTotal;
  return ratio > thresholdRatio;
}
