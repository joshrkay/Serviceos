import type { Request } from 'express';
import { getSentryClient } from './sentry';

/**
 * R1 — every unhandled 5xx reaches Sentry. Shared by the global error
 * handler (app.ts) and asyncRoute (middleware/async-route.ts), which maps
 * handler rejections inline and so never reaches the global handler.
 *
 * Tags are set per event via withScope (no leakage between concurrent
 * requests) from already-redacted sources, because scope tags bypass the
 * beforeSend redaction: the route is safeRequestLog.route (redactUrlValue'd
 * by request logging), never req.originalUrl; the request id is the
 * correlation_id request logging minted; the tenant comes from req.auth
 * (webhook/telephony paths have no tenant store — the tag is simply
 * omitted). Callers gate on the mapped status so 4xx never captures. The
 * no-op client (SENTRY_DSN unset) makes this a no-op; any monitoring failure
 * is swallowed so it can never break the error response.
 */
export function captureServerError(err: unknown, req: Request): void {
  try {
    const anyReq = req as unknown as {
      safeRequestLog?: { route?: string; correlation_id?: string };
      auth?: { tenantId?: string };
    };
    const route = anyReq.safeRequestLog?.route ?? req.path;
    const requestId = anyReq.safeRequestLog?.correlation_id;
    const tenantId = anyReq.auth?.tenantId;
    const error = err instanceof Error ? err : new Error(String(err));
    getSentryClient().withScope((scope) => {
      scope.setTag('route', route);
      if (requestId) scope.setTag('request_id', requestId);
      if (tenantId) scope.setTag('tenant_id', tenantId);
      scope.captureException(error);
    });
  } catch {
    // monitoring must never break the error response
  }
}
