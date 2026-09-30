/**
 * #1489 — `Idempotency-Key` support for the create routes.
 *
 * A client that may retry a create (network timeout, double submit) sends the
 * same `Idempotency-Key` header on every attempt. The key is scoped to the
 * caller's tenant and user:
 *
 *   - first request with the key            → runs; a 2xx response is stored
 *   - same key + same body, after success   → the stored status/body is replayed
 *                                              (`Idempotent-Replayed: true`),
 *                                              no second record
 *   - an attempt that fails (>= 400)        → not stored; a retry runs again
 *   - same key + different body             → 422 IDEMPOTENCY_KEY_REUSED
 *   - same key while the first is in flight → waits for it and replays; past
 *                                              the store's wait bound, 409
 *                                              IDEMPOTENCY_IN_PROGRESS
 *
 * Requests without the header behave exactly as before.
 */
import { createHash } from 'crypto';
import type { Express, NextFunction, Request, Response } from 'express';
import type { AuthenticatedRequest } from '../auth/clerk';
import type { IdempotencyScope, IdempotencyStore } from './idempotency-store';


/** The create endpoints that honour `Idempotency-Key` (POST only). */
export const IDEMPOTENT_CREATE_PATHS = [
  '/api/customers',
  '/api/jobs',
  '/api/appointments',
  '/api/estimates',
  '/api/invoices',
  '/api/payments',
] as const;

export const IDEMPOTENCY_HEADER = 'Idempotency-Key';

/** 1-255 printable ASCII characters (a UUID from the web client fits). */
const VALID_KEY = /^[\x21-\x7e]{1,255}$/;

/** Key order must not change the fingerprint of an otherwise equal body. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function fingerprintOf(req: Request): string {
  return createHash('sha256')
    .update(`${req.method} ${req.path}\n${canonicalJson(req.body)}`)
    .digest('hex');
}

function chunkToString(chunk: unknown, encoding: unknown): string {
  if (chunk === undefined || chunk === null || typeof chunk === 'function') return '';
  if (Buffer.isBuffer(chunk)) return chunk.toString('utf8');
  if (typeof chunk === 'string') {
    return typeof encoding === 'string' && encoding !== 'utf8' && encoding !== 'utf-8'
      ? Buffer.from(chunk, encoding as BufferEncoding).toString('utf8')
      : chunk;
  }
  return String(chunk);
}

export function createIdempotencyMiddleware(store: IdempotencyStore) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const key = req.header(IDEMPOTENCY_HEADER);
    const auth = (req as AuthenticatedRequest).auth;
    if (key === undefined || !auth?.tenantId || !auth.userId) {
      next();
      return;
    }
    if (!VALID_KEY.test(key)) {
      res.status(400).json({
        error: 'INVALID_IDEMPOTENCY_KEY',
        message: 'Idempotency-Key must be 1-255 printable ASCII characters.',
      });
      return;
    }
    const scope: IdempotencyScope = { tenantId: auth.tenantId, userId: auth.userId, key };

    try {
      const claim = await store.claim(scope, fingerprintOf(req));
      if (claim.kind === 'mismatch') {
        res.status(422).json({
          error: 'IDEMPOTENCY_KEY_REUSED',
          message: 'This Idempotency-Key was already used with a different request.',
        });
        return;
      }
      if (claim.kind === 'in_progress') {
        res.status(409).json({
          error: 'IDEMPOTENCY_IN_PROGRESS',
          message: 'A request with this Idempotency-Key is still being processed. Retry shortly.',
        });
        return;
      }
      if (claim.kind === 'replay') {
        res.status(claim.response.status);
        if (claim.response.contentType) res.setHeader('Content-Type', claim.response.contentType);
        res.setHeader('Idempotent-Replayed', 'true');
        res.end(claim.response.body);
        return;
      }
    } catch (err) {
      next(err);
      return;
    }

    // Capture the response on its way out. The write must finish before the
    // underlying `end` runs: the request transaction settles inside it.
    const originalEnd = res.end as unknown as (...args: unknown[]) => Response;
    let ending = false;
    res.end = function endAfterRecording(this: Response, ...args: unknown[]): Response {
      if (ending) return res;
      ending = true;
      const [chunk, encoding] = args;
      const status = res.statusCode;
      const record = async (): Promise<void> => {
        if (status >= 400) {
          await store.release(scope);
          return;
        }
        const contentType = res.getHeader('Content-Type');
        await store.complete(scope, {
          status,
          contentType: typeof contentType === 'string' ? contentType : null,
          body: chunkToString(chunk, encoding),
        });
      };
      record()
        .catch(() => {
          /* the request transaction's own settle path reports DB failures */
        })
        .finally(() => {
          // The response was decided at the first `end`; a late writer during
          // the store write cannot change its status.
          res.statusCode = status;
          originalEnd.apply(res, args);
        });
      return res;
    } as unknown as Response['end'];

    next();
  };
}

/**
 * Mount the idempotency middleware on the create routes. Must run after
 * authentication and the request-scoped tenant transaction, and before the
 * routers themselves.
 */
export function mountIdempotentCreateRoutes(app: Express, store: IdempotencyStore): void {
  app.post([...IDEMPOTENT_CREATE_PATHS], createIdempotencyMiddleware(store));
}
