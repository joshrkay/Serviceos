import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import type { Logger } from '../logging/logger';
import { redactUrlValue } from '../logging/redact';

const SENSITIVE_KEY_PATTERN = /(authorization|cookie|token|secret|password|api[_-]?key)/i;

function sanitizeValue(value: unknown, depth = 0): unknown {
  if (depth > 5) return '[TRUNCATED]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    return value.length > 2000 ? `${value.slice(0, 2000)}...[TRUNCATED]` : value;
  }
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, depth + 1));

  const input = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(input)) {
    out[key] = SENSITIVE_KEY_PATTERN.test(key) ? '[REDACTED]' : sanitizeValue(val, depth + 1);
  }
  return out;
}

function sanitizeHeaders(headers: Request['headers']): Record<string, string | string[] | undefined> {
  const denyList = new Set(['authorization', 'cookie', 'set-cookie', 'x-api-key', 'proxy-authorization']);
  const result: Record<string, string | string[] | undefined> = {};
  for (const [key, value] of Object.entries(headers)) {
    result[key] = denyList.has(key.toLowerCase()) ? '[REDACTED]' : value;
  }
  return result;
}

function toErrorCodeFields(err: unknown): Record<string, unknown> {
  if (!err || typeof err !== 'object') return {};
  const anyErr = err as Record<string, unknown>;
  return {
    ...(typeof anyErr.code === 'string' ? { errorCode: anyErr.code } : {}),
    ...(typeof anyErr.name === 'string' ? { errorName: anyErr.name } : {}),
    ...(typeof anyErr.statusCode === 'number' ? { errorStatusCode: anyErr.statusCode } : {}),
  };
}

export function createRequestLoggingMiddleware(logger: Logger) {
  return (req: Request, res: Response, next: NextFunction) => {
    const startedAt = process.hrtime.bigint();
    const correlationId = (req.headers['x-correlation-id'] as string | undefined) || randomUUID();
    // SEC-26 — prefer the verified auth context for tenant attribution in
    // logs; the `x-tenant-id` header is client-forgeable and is only used
    // as a fallback for unauthenticated (no req.auth) requests, e.g. public
    // token-gated routes that never populate req.auth.
    const tenantId = (req as any).auth?.tenantId || (req.headers['x-tenant-id'] as string | undefined);

    const safeRequestLog = {
      method: req.method,
      // SEC-20 — the raw URL/path can carry a live bearer token, either as
      // a `?token=` query param or as the `:token` path segment on public
      // routes (see PUBLIC_TOKEN_PATH_PATTERNS in logging/redact.ts).
      // sanitizeValue below only redacts by KEY name, so it never inspects
      // this string value — redactUrlValue does the value-pattern scrub.
      route: redactUrlValue(req.originalUrl || req.path),
      correlation_id: correlationId,
      tenant_id: tenantId,
      params: sanitizeValue(req.params),
      query: sanitizeValue(req.query),
      body: sanitizeValue(req.body),
      headers: sanitizeHeaders(req.headers),
    };

    (req as any).safeRequestLog = safeRequestLog;
    res.setHeader('x-correlation-id', correlationId);

    logger.info('incoming request', { safeRequestLog });

    res.on('finish', () => {
      const latencyMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      const sizeHeader = res.getHeader('content-length');
      const responseSize = typeof sizeHeader === 'string' ? Number(sizeHeader) : sizeHeader;
      const err = (res.locals as Record<string, unknown>).requestError;

      logger.info('request completed', {
        safeRequestLog,
        response: {
          status: res.statusCode,
          latency_ms: Math.round(latencyMs * 100) / 100,
          size_bytes: typeof responseSize === 'number' && Number.isFinite(responseSize) ? responseSize : undefined,
          ...toErrorCodeFields(err),
        },
      });
    });

    next();
  };
}

export function captureRequestError() {
  return (err: unknown, _req: Request, res: Response, next: NextFunction) => {
    (res.locals as Record<string, unknown>).requestError = err;
    next(err);
  };
}
