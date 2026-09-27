import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * #1205 item 3 — the ONE seam that makes "every 5xx reaches Sentry" true.
 *
 * captureServerError is only reached from the global error handler and
 * asyncRoute. ~107 route handlers instead `catch` and answer 500 themselves
 * (`res.status(500).json(...)`), so those failures never reached Sentry.
 * Rather than editing every handler, this response hook watches every
 * response: when one finishes with a 5xx that nothing already reported,
 * it reports it through the same capture path (same redacted route /
 * request_id / tenant_id tags).
 *
 * Deduplication: captureServerError marks the request, so an error that the
 * global handler or asyncRoute already captured is never reported twice.
 * The check runs on the tick AFTER `finish`, because a handler can commit a
 * 500 and only then hand the error to next(err) — the real error should win
 * over the synthetic one.
 */

const reported = new WeakSet<Request>();

/** Record that this request's server error has been sent to Sentry. */
export function markServerErrorReported(req: Request): void {
  reported.add(req);
}

export function wasServerErrorReported(req: Request): boolean {
  return reported.has(req);
}

/** Path segments that are ids, collapsed so one handler groups as one issue. */
const ID_SEGMENT = /^(?:\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

function groupingLabel(route: string): string {
  const q = route.indexOf('?');
  const path = q === -1 ? route : route.slice(0, q);
  return path
    .split('/')
    .map((seg) => (ID_SEGMENT.test(seg) ? ':id' : seg))
    .join('/');
}

export class HandlerWrittenServerError extends Error {
  constructor(status: number, method: string, route: string) {
    super(`Handler answered ${status} without reporting: ${method} ${groupingLabel(route)}`);
    this.name = 'HandlerWrittenServerError';
  }
}

export function reportHandlerWrittenServerErrors(deps: {
  capture: (err: unknown, req: Request) => void;
  routeOf: (req: Request) => string;
}): RequestHandler {
  // Named: test/middleware/handler-written-5xx-sentry.test.ts asserts this
  // layer sits in front of every router createApp() mounts.
  return function reportHandlerWrittenServerErrorsHook(req: Request, res: Response, next: NextFunction) {
    res.on('finish', () => {
      if (res.statusCode < 500) return;
      setImmediate(() => {
        if (wasServerErrorReported(req)) return;
        try {
          deps.capture(new HandlerWrittenServerError(res.statusCode, req.method, deps.routeOf(req)), req);
        } catch {
          // monitoring must never break the process
        }
      });
    });
    next();
  };
}
