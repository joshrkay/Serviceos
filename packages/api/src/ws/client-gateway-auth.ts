/**
 * Authentication + authorization for the client WebSocket gateway (/api/ws).
 *
 * Mirrors the HTTP chain (verifyClerkSession → resolveAuthorization):
 *   1. Verify the Clerk token (RS256; HMAC only under the SAME production
 *      guard the HTTP path uses, and never with an empty secret).
 *   2. Gate on the caller's LIVE membership via `decideMembership` — the same
 *      decision resolveAuthorization makes — so a suspended / deleted /
 *      removed user holding a still-valid token cannot open a socket, and the
 *      DB role wins over the token's role claim.
 *   3. Hand the gateway the token's `exp` (socket closes when it passes) and a
 *      `revalidate` hook it calls periodically for the life of the socket.
 */
import type { IncomingMessage } from 'http';
import {
  decodeClerkToken,
  isHmacDevModeEnabled,
  parseAuthorizedParties,
  verifyRs256Token,
  type ClerkTokenPayload,
} from '../auth/clerk';
import { decideMembership } from '../middleware/auth';
import { createLogger } from '../logging/logger';
import type { AuthResolver, AuthResult, RevalidateOutcome } from './client-gateway';

const logger = createLogger({
  service: 'ws.client-gateway-auth',
  environment: process.env.NODE_ENV || 'development',
});

export interface ClientGatewayAuthDeps {
  /** Env snapshot (CLERK_* / NODE_ENV). Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  verifyRs256?: (
    token: string,
    opts: { pubKey: string; authorizedParties?: readonly string[] },
  ) => Promise<ClerkTokenPayload>;
  decodeHmac?: (token: string, secretKey: string) => ClerkTokenPayload;
  decide?: typeof decideMembership;
}

/**
 * Token via Authorization header (rare for WS), `?token=`, or a
 * `bearer.<token>` Sec-WebSocket-Protocol entry.
 */
export function extractClientGatewayToken(req: IncomingMessage): string | undefined {
  const authHeader = req.headers.authorization;
  const proto = (req.headers['sec-websocket-protocol'] as string | undefined) ?? '';
  const url = new URL(req.url ?? '/', 'http://localhost');
  const queryToken = url.searchParams.get('token') ?? undefined;
  const headerToken =
    authHeader && authHeader.startsWith('Bearer ') ? authHeader.substring(7) : undefined;
  const protoToken = proto
    .split(',')
    .map((s) => s.trim())
    .find((s) => s.startsWith('bearer.'))
    ?.substring('bearer.'.length);
  return headerToken || queryToken || protoToken || undefined;
}

export function createClientGatewayAuth(deps: ClientGatewayAuthDeps = {}): Required<AuthResolver> {
  const verifyRs256 = deps.verifyRs256 ?? verifyRs256Token;
  const decodeHmac = deps.decodeHmac ?? decodeClerkToken;
  const decide = deps.decide ?? decideMembership;

  const verifyToken = async (token: string): Promise<ClerkTokenPayload> => {
    const env = deps.env ?? process.env;
    const hmacSecret = env.CLERK_SECRET_KEY;
    // Same runtime production guard as verifyClerkSession; an unset/empty
    // secret never verifies anything (an HMAC over '' is forgeable).
    if (isHmacDevModeEnabled(env) && hmacSecret) {
      return decodeHmac(token, hmacSecret);
    }
    return verifyRs256(token, {
      pubKey: env.CLERK_PUBLISHABLE_KEY ?? '',
      authorizedParties: parseAuthorizedParties(env.CLERK_AUTHORIZED_PARTIES),
    });
  };

  return {
    authenticate: async (req): Promise<AuthResult | null> => {
      const token = extractClientGatewayToken(req);
      if (!token) return null;

      let payload: ClerkTokenPayload;
      try {
        payload = await verifyToken(token);
      } catch {
        return null;
      }
      if (!payload?.tenant_id || !payload.sub) return null;

      const expiresAtMs = typeof payload.exp === 'number' ? payload.exp * 1000 : undefined;
      const decision = await decide(payload.sub, payload.tenant_id);
      switch (decision.outcome) {
        case 'unchecked':
          // No loader wired (no-DB dev / dev-auth-bypass) — the HTTP path
          // keeps the token claim here too.
          return {
            tenantId: payload.tenant_id,
            userId: payload.sub,
            role: payload.role,
            expiresAtMs,
          };
        case 'allowed':
          return {
            tenantId: payload.tenant_id,
            userId: payload.sub,
            role: decision.membership.role,
            expiresAtMs,
          };
        case 'unavailable':
          logger.error('client-gateway authorization unavailable — failing closed', {
            reason:
              decision.error instanceof Error ? decision.error.message : String(decision.error),
            tenantId: payload.tenant_id,
          });
          return null;
        case 'no_membership':
        case 'revoked':
          logger.warn('client-gateway upgrade denied — no active membership', {
            outcome: decision.outcome,
            tenantId: payload.tenant_id,
          });
          return null;
      }
    },

    revalidate: async (auth): Promise<RevalidateOutcome> => {
      if (!auth.userId) return 'revoked';
      const decision = await decide(auth.userId, auth.tenantId);
      switch (decision.outcome) {
        case 'unchecked':
        case 'allowed':
          return 'ok';
        case 'unavailable':
          return 'unavailable';
        case 'no_membership':
        case 'revoked':
          return 'revoked';
      }
    },
  };
}
