/**
 * P10-001 — Express middleware that resolves a plaintext portal token
 * from `:token` and attaches `req.portal = { tenantId, customerId,
 * sessionId }`. Used by every `/api/public/portal/...` route.
 *
 * Rate limit: simple per-token in-memory token bucket (60 req/min).
 * Documented HA limitation: limits are process-local — multiple API
 * instances each enforce 60/min. Acceptable for the v1 portal; if we
 * ever need cross-instance enforcement, swap for a Redis bucket.
 */
import { NextFunction, Request, RequestHandler, Response } from 'express';
import {
  PortalSessionRepository,
} from './portal-session';
import {
  ResolvedPortalSession,
  resolvePortalToken,
} from './portal-service';

export interface PortalRequest extends Request {
  portal?: ResolvedPortalSession;
}

export interface PortalRateLimitOptions {
  /** Max requests per token per window. Default 60. */
  max?: number;
  /** Window in milliseconds. Default 60_000 (1 minute). */
  windowMs?: number;
  /** Cap on the in-memory bucket map to keep memory bounded. Default 10_000. */
  maxBuckets?: number;
}

interface Bucket {
  count: number;
  windowStart: number;
}

/**
 * Process-local token bucket. The map is bounded so a runaway attacker
 * spraying random tokens can't drive the API out of memory; entries
 * expire when their window does, and we evict the oldest when the cap
 * is hit. HA limitation: enforcement is per-process.
 */
class TokenBucketRegistry {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly maxBuckets: number,
  ) {}

  /**
   * Returns `true` if the request is allowed. Increments the count
   * for the active window and rotates the window when it expires.
   */
  allow(key: string, now: number): boolean {
    const bucket = this.buckets.get(key);
    if (bucket) {
      if (now - bucket.windowStart >= this.windowMs) {
        // Existing key, new window — overwrite in place. Map size is
        // unchanged, so eviction would be premature here.
        bucket.count = 1;
        bucket.windowStart = now;
        return true;
      }
      if (bucket.count >= this.max) return false;
      bucket.count += 1;
      return true;
    }
    // Brand-new key — only now do we risk growing the map. Evict if at cap.
    if (this.buckets.size >= this.maxBuckets) {
      const oldestKey = this.buckets.keys().next().value as string | undefined;
      if (oldestKey !== undefined) this.buckets.delete(oldestKey);
    }
    this.buckets.set(key, { count: 1, windowStart: now });
    return true;
  }

  /** Test helper — clear all state. */
  reset(): void {
    this.buckets.clear();
  }
}

export interface PortalTokenMiddlewareOptions {
  rateLimit?: PortalRateLimitOptions;
  /** Override the clock for tests. Returns ms since epoch. */
  now?: () => number;
}

export function createPortalTokenMiddleware(
  repo: PortalSessionRepository,
  options: PortalTokenMiddlewareOptions = {},
): RequestHandler {
  const max = options.rateLimit?.max ?? 60;
  const windowMs = options.rateLimit?.windowMs ?? 60_000;
  const maxBuckets = options.rateLimit?.maxBuckets ?? 10_000;
  const now = options.now ?? (() => Date.now());

  const buckets = new TokenBucketRegistry(max, windowMs, maxBuckets);

  return async (req: PortalRequest, res: Response, next: NextFunction): Promise<void> => {
    const token = req.params.token;
    if (!token) {
      res.status(401).json({ error: 'UNAUTHORIZED', message: 'Missing portal token' });
      return;
    }

    // Validate token shape BEFORE touching the rate-limit map. Tokens are
    // 64 hex chars (`crypto.randomBytes(32).toString('hex')`); anything else
    // can't possibly resolve, and accepting arbitrary strings as Map keys
    // would let an attacker spray large unique strings to grow the bucket
    // map's heap footprint between evictions.
    if (!isValidTokenShape(token)) {
      res.status(401).json({ error: 'UNAUTHORIZED', message: 'Invalid or expired portal token' });
      return;
    }

    // Rate-limit BEFORE the DB lookup so a flood of bad tokens can't
    // amplify into a DB hot path.
    if (!buckets.allow(token, now())) {
      res.status(429).json({
        error: 'RATE_LIMITED',
        message: 'Too many portal requests',
      });
      return;
    }

    try {
      const resolved = await resolvePortalToken(token, repo, new Date(now()));
      if (!resolved) {
        res.status(401).json({ error: 'UNAUTHORIZED', message: 'Invalid or expired portal token' });
        return;
      }
      req.portal = resolved;
      next();
    } catch (err) {
      // Fail closed — log internally, return a generic message so we don't
      // leak DB / driver internals to an unauthenticated caller.
      // eslint-disable-next-line no-console
      console.error('[portal] token resolution failed', err);
      res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Token resolution failed' });
    }
  };
}

const PORTAL_TOKEN_RE = /^[0-9a-f]{64}$/i;

function isValidTokenShape(token: string): boolean {
  return PORTAL_TOKEN_RE.test(token);
}
