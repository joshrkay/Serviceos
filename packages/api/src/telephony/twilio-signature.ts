/**
 * Twilio webhook signature verification.
 *
 * Twilio signs every webhook with HMAC-SHA1 over the full request URL +
 * sorted form-body parameters (or the JSON body for newer endpoints).
 * `validateRequest` from the Twilio SDK does the canonical comparison —
 * we wrap it so callers don't have to import the SDK directly.
 *
 * URL strategy
 * ────────────
 * Twilio signs the EXACT URL it called. Behind a proxy/load balancer
 * (Railway, ngrok), `req.protocol` and `req.get('host')` may not match
 * what Twilio used. To make this deterministic, we accept a `PUBLIC_API_URL`
 * env var as the canonical base. When set, the middleware reconstructs the
 * URL as `PUBLIC_API_URL + req.originalUrl`. Otherwise we fall back to
 * `req.protocol + '://' + req.get('host') + req.originalUrl`.
 *
 * Required env vars (documented in commit message — do not add real values):
 *   TWILIO_AUTH_TOKEN  — used by validateRequest to compute the expected sig
 *   PUBLIC_API_URL     — optional; set when running behind a proxy
 */

import type { Request, Response, NextFunction } from 'express';
import twilio from 'twilio';

/**
 * Verify a Twilio webhook signature.
 *
 * @param signatureHeader  Value of the `X-Twilio-Signature` request header.
 * @param url              The full URL Twilio called (must match exactly).
 * @param params           Form-body params (`application/x-www-form-urlencoded`).
 * @param authToken        Twilio account auth token.
 * @returns true when the signature is valid.
 */
export function verifyTwilioSignature(
  signatureHeader: string | undefined,
  url: string,
  params: Record<string, string>,
  authToken: string,
): boolean {
  if (!signatureHeader || !authToken) return false;
  try {
    return twilio.validateRequest(authToken, signatureHeader, url, params);
  } catch {
    return false;
  }
}

/**
 * Build the canonical webhook URL the way Twilio signed it.
 *
 * Prefers `PUBLIC_API_URL` (env) so deployments behind proxies don't
 * mismatch on `req.protocol` / `Host`. Falls back to the request's
 * own protocol+host when the env var is unset.
 */
export function reconstructWebhookUrl(
  req: Request,
  publicBaseUrl?: string,
): string {
  if (publicBaseUrl) {
    const trimmed = publicBaseUrl.replace(/\/+$/, '');
    return `${trimmed}${req.originalUrl}`;
  }
  const proto = (req.headers['x-forwarded-proto'] as string | undefined) ?? req.protocol;
  const host = req.get('host') ?? '';
  return `${proto}://${host}${req.originalUrl}`;
}

/**
 * Express middleware factory that rejects requests with an invalid
 * `X-Twilio-Signature` header. Returns `403` on failure.
 *
 * The factory takes a getter so the auth token can be read lazily —
 * useful in test environments where we want to construct the router
 * before the env var is set.
 */
export function requireTwilioSignature(
  authTokenGetter: () => string | undefined,
  options: { publicBaseUrl?: string | (() => string | undefined) } = {},
): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction) => {
    const authToken = authTokenGetter();
    if (!authToken) {
      // Fail-closed: never accept Twilio webhooks if the token is unset.
      // This mirrors how the Stripe webhook route 500s when its secret is
      // missing — the operator sees the misconfiguration loudly.
      res.status(500).end();
      return;
    }

    const baseUrl = typeof options.publicBaseUrl === 'function'
      ? options.publicBaseUrl()
      : options.publicBaseUrl;

    const url = reconstructWebhookUrl(req, baseUrl ?? process.env.PUBLIC_API_URL);
    const signature = req.header('x-twilio-signature');

    // Twilio sends form-encoded bodies. Express's urlencoded() parser puts
    // them on req.body as plain strings — exactly what validateRequest
    // expects. Coerce defensively in case the route gets called with an
    // unexpected body shape.
    const params: Record<string, string> = {};
    if (req.body && typeof req.body === 'object') {
      for (const [k, v] of Object.entries(req.body as Record<string, unknown>)) {
        if (typeof v === 'string') params[k] = v;
        else if (v != null) params[k] = String(v);
      }
    }

    if (!verifyTwilioSignature(signature, url, params, authToken)) {
      res.status(403).end();
      return;
    }

    next();
  };
}
