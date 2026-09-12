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
import { createLogger } from '../logging/logger';

const logger = createLogger({
  service: 'telephony.signature',
  environment: process.env.NODE_ENV || 'development',
});

/** Which credential answered for a webhook — logged on every accepted request. */
export type TwilioCredentialPath =
  /** The credential of the tenant that owns the dialled number. */
  | 'tenant_integration'
  /** Legacy AccountSid-keyed credential; only for payloads naming no number we own. */
  | 'subaccount_lookup'
  /** The deployment's own TWILIO_AUTH_TOKEN. */
  | 'deployment_fallback';

/**
 * What the credential resolver answers for one request (#1072). `refuse` is a
 * 403 the resolver reached on its own — a credential that does not belong to
 * the tenant that owns the dialled number — decided BEFORE any handler runs,
 * and therefore before any session / lead / customer / audit write.
 * `misconfigured` is a 500: the deployment cannot produce the credential this
 * request must be checked against, which is an operator problem, not a caller
 * one.
 */
export type TwilioCredentialDecision =
  | { outcome: 'verify'; authToken: string; path: TwilioCredentialPath; tenantId?: string }
  | { outcome: 'refuse'; reason: string; tenantId?: string }
  | { outcome: 'misconfigured'; reason: string; tenantId?: string };

/**
 * What the resolver is given about a request. `to` is the field that binds the
 * credential to a tenant; `tenantId` is for callers that already hold a trusted
 * tenant (the media-stream upgrade, off its in-process session).
 */
export interface TwilioCredentialContext {
  accountSid?: string;
  to?: string;
  tenantId?: string;
}

/**
 * Per-request credential resolver. Returning a bare token string is the legacy
 * shape (a fixed single-account token — what tests and single-tenant wiring
 * pass); production wiring returns a `TwilioCredentialDecision` so the refusal
 * and misconfiguration cases are distinguishable from a bad HMAC.
 */
export type TwilioAuthTokenGetter = (
  ctx: TwilioCredentialContext,
) =>
  | Promise<string | undefined | TwilioCredentialDecision>
  | string
  | undefined
  | TwilioCredentialDecision;

/**
 * Where the middleware records the tenant whose credential actually verified a
 * request. A Symbol rather than a plain property so it cannot collide with —
 * or be spoofed through — anything a body parser puts on the request.
 */
const VERIFIED_TENANT = Symbol('twilioVerifiedTenantId');

/**
 * The tenant whose own Twilio credential verified this request, when a
 * tenant-owned credential did. Undefined when the deployment-wide fallback
 * token verified it (single-account deployments and unowned numbers), where no
 * tenant is implied and callers must fall back to their own tenant resolution.
 *
 * #1072 — session-scoped callbacks need this: a valid signature proves the
 * caller owns SOME number, never that it owns the call a `?sid=` names.
 */
export function getVerifiedTwilioTenantId(req: Request): string | undefined {
  return (req as Request & { [VERIFIED_TENANT]?: string })[VERIFIED_TENANT];
}

/**
 * #1072 — the guard every session-scoped telephony callback shares.
 *
 * These routes name their target with an identifier the CALLER supplies (a
 * `?sid=`, or a `CallSid` the handler resolves a session from) and then act as
 * whatever tenant that session belongs to. A valid signature proves the caller
 * owns the number it dialled; it never proves the caller owns the call. Without
 * this check a tenant can sign with its OWN credential, name another tenant's
 * live call, and act inside it — driving the conversation on `/gather`, or
 * attaching its own recording to the victim's call on `/recording`.
 *
 * The authority is the tenant whose credential actually verified the request.
 * `fallbackTenantId` is consulted only when no tenant credential answered (the
 * deployment-wide token — single-account deployments, where no tenant holds the
 * token and there is no tenant-attacker); with neither, there is nothing to
 * check against and the guard stands down rather than guessing.
 *
 * A session that does not exist is NOT a violation: the callers have their own
 * handling for a reaped or unknown id, and answering 403 there would turn an
 * ordinary expiry into a hard failure — and would leak which ids exist.
 */
export function sessionBelongsToAnotherTenant(
  req: Request,
  session: { tenantId: string } | undefined,
  fallbackTenantId?: string,
): boolean {
  if (!session) return false;
  const authority = getVerifiedTwilioTenantId(req) ?? fallbackTenantId;
  if (!authority) return false;
  return session.tenantId !== authority;
}

/** First defined string among a Twilio payload's dialled-number aliases. */
function readDialedNumber(req: Request): string | undefined {
  const body = (req.body && typeof req.body === 'object'
    ? (req.body as Record<string, unknown>)
    : {}) as Record<string, unknown>;
  // `To` on call webhooks, `Called` on recording/status callbacks, and the
  // query param the voicemail callback URL mints for itself when Twilio's
  // recordingStatusCallback body carries neither.
  const query = req.query as Record<string, unknown>;
  const candidates = [body.To, body.Called, query.To, query.Called];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return undefined;
}

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
 * The factory takes an async getter so the auth token can be resolved
 * per-request. #1072: the credential must be the one belonging to the tenant
 * that owns the DIALLED NUMBER, so the getter is handed the payload's `To`
 * (and `AccountSid`) and may answer `refuse` — a 403 decided here, before any
 * handler and therefore before any session / lead / customer / audit write.
 * The legacy single-account flow passes a getter that ignores its argument and
 * returns the global `TWILIO_AUTH_TOKEN`.
 */
export function requireTwilioSignature(
  authTokenGetter: TwilioAuthTokenGetter,
  options: { publicBaseUrl?: string | (() => string | undefined) } = {},
): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  return async (req: Request, res: Response, next: NextFunction) => {
    const accountSid = (req.body && typeof req.body === 'object'
      ? (req.body as Record<string, unknown>).AccountSid
      : undefined) as string | undefined;
    const to = readDialedNumber(req);

    const resolved = await Promise.resolve(
      authTokenGetter({
        ...(accountSid ? { accountSid } : {}),
        ...(to ? { to } : {}),
      }),
    );

    let authToken: string | undefined;
    let credentialPath: TwilioCredentialPath = 'deployment_fallback';
    let credentialTenantId: string | undefined;
    if (typeof resolved === 'object') {
      if (resolved.outcome === 'refuse') {
        // The presented credential does not belong to the tenant that owns the
        // dialled number. Refuse here — nothing downstream runs.
        logger.warn('telephony.signature_refused', {
          route: req.path,
          reason: resolved.reason,
          ...(resolved.tenantId ? { tenantId: resolved.tenantId } : {}),
        });
        res.status(403).end();
        return;
      }
      if (resolved.outcome === 'misconfigured') {
        logger.error('telephony.signature_misconfigured', {
          route: req.path,
          reason: resolved.reason,
        });
        res.status(500).end();
        return;
      }
      authToken = resolved.authToken;
      credentialPath = resolved.path;
      credentialTenantId = resolved.tenantId;
    } else {
      authToken = resolved;
    }

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
      logger.warn('telephony.signature_invalid', {
        route: req.path,
        credentialPath,
        ...(credentialTenantId ? { tenantId: credentialTenantId } : {}),
      });
      res.status(403).end();
      return;
    }

    // #1072 — hand the verified tenant to the routes. A session-scoped
    // callback compares its `?sid=` session against THIS, not against a tenant
    // re-derived from the payload: the payload only says which number the
    // caller dialled, and owning a number is not owning a call.
    if (credentialTenantId) {
      (req as Request & { [VERIFIED_TENANT]?: string })[VERIFIED_TENANT] = credentialTenantId;
    }

    // #1072 — which credential actually answered for this request. The
    // operator needs this to tell a tenant-bound verification from the
    // deployment-wide fallback without re-deriving it from the payload.
    logger.info('telephony.signature_verified', {
      route: req.path,
      credentialPath,
      ...(credentialTenantId ? { tenantId: credentialTenantId } : {}),
    });

    next();
  };
}
