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
  // #1205 — prefer the matched route PATTERN (`/api/customers/:id`): it is
  // stable for grouping and carries no request data. The query string is
  // never part of the label — `?search=Jane Doe 602-555-0199` on a 500 would
  // otherwise land in an indexed Sentry tag (redactUrlValue only scrubs
  // token-like params, not free-text search).
  const anyReq = req as unknown as {
    safeRequestLog?: { route?: string };
    route?: { path?: unknown };
    baseUrl?: string;
  };
  const pattern = anyReq.route?.path;
  if (typeof pattern === 'string' && pattern.length > 0) {
    return `${anyReq.baseUrl ?? ''}${pattern}`;
  }
  const logged = anyReq.safeRequestLog?.route;
  const raw =
    typeof logged === 'string' && logged.length > 0
      ? logged
      : redactUrlValue(req.originalUrl || req.path);
  return stripQuery(raw);
}

function stripQuery(url: string): string {
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

/**
 * R1 — reports a 5xx to Sentry. Shared by the global error handler (app.ts)
 * and asyncRoute (middleware/async-route.ts), which maps handler rejections
 * inline and so never reaches the global handler. NOT every 5xx: route
 * handlers that catch and answer 500 themselves (the `toErrorResponse`
 * pattern) and errors after headers were sent do not pass through here
 * (#1205 item 3 — tracked as follow-up, not swept in one change).
 *
 * Tags are set per event via withScope (no leakage between concurrent
 * requests) from already-redacted sources. Tags DO pass through beforeSend,
 * but redactSentryEvent (logging/redact.ts) deliberately leaves them
 * unmasked so tenant_id stays filterable (#1205) — which is exactly why they
 * must be built from redacted sources here: the route is redactedRoute()
 * (the matched route PATTERN, or the token-scrubbed path with the query
 * string dropped); the request id is the
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
