import type { Request } from 'express';
import { redactUrlValue } from '../logging/redact';
import { getSentryClient } from './sentry';

/**
 * The route label for error telemetry (Sentry tags, PostHog api_error).
 * Prefers the route request logging already redacted; when that middleware
 * never ran for this request (mounted earlier, or a failure inside it) the
 * fallback is scrubbed here rather than passed raw — a public token route
 * (`/public/estimates/:token`, `?token=`) would otherwise land in a Sentry
 * tag, which `beforeSend` never inspects.
 */
export function redactedRoute(req: Request): string {
  const anyReq = req as unknown as { safeRequestLog?: { route?: string } };
  const logged = anyReq.safeRequestLog?.route;
  if (typeof logged === 'string' && logged.length > 0) return logged;
  return redactUrlValue(req.originalUrl || req.path);
}

/**
 * R1 — every unhandled 5xx reaches Sentry. Shared by the global error
 * handler (app.ts) and asyncRoute (middleware/async-route.ts), which maps
 * handler rejections inline and so never reaches the global handler.
 *
 * Tags are set per event via withScope (no leakage between concurrent
 * requests) from already-redacted sources, because scope tags bypass the
 * beforeSend redaction: the route is redactedRoute() (safeRequestLog.route
 * as redactUrlValue'd by request logging, or the same scrub applied here
 * when that middleware never ran); the request id is the
 * correlation_id request logging minted; the tenant comes from req.auth
 * (webhook/telephony paths have no tenant store — the tag is simply
 * omitted). Callers gate on the mapped status so 4xx never captures. The
 * no-op client (SENTRY_DSN unset) makes this a no-op; any monitoring failure
 * is swallowed so it can never break the error response.
 */
export function captureServerError(err: unknown, req: Request): void {
  try {
    const anyReq = req as unknown as {
      safeRequestLog?: { correlation_id?: string };
      auth?: { tenantId?: string };
    };
    const route = redactedRoute(req);
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
