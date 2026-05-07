import type { Request } from 'express';

/**
 * Extract the client IP from a request. Honors the first hop in
 * X-Forwarded-For when present (the platform sets it; trust-proxy
 * must be enabled for `req.ip` alone to be correct on the LB).
 */
export function extractIp(req: Request): string | undefined {
  const forwarded = req.get('x-forwarded-for');
  if (forwarded) {
    return forwarded.split(',')[0]?.trim();
  }
  return req.ip;
}
