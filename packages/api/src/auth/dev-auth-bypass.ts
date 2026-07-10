import { Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import { AuthenticatedRequest, Tenant, TenantRepository } from './clerk';
import { createLogger } from '../logging/logger';

/**
 * DEV-ONLY auth bypass.
 *
 * Background: P0-033 made `verifyClerkSession` verify real RS256 Clerk
 * session tokens via the published JWKS, so the production path now works
 * end-to-end against a real Clerk instance. Two side-channels remain for
 * local dev — both are hard-gated and refused in production:
 *
 *   1. `DEV_AUTH_BYPASS=true` (this middleware): skips signature
 *      verification entirely, decodes the JWT body, and auto-bootstraps a
 *      tenant for the Clerk user. Use only when you don't have real
 *      Clerk-issued tokens locally. MUST remain OFF in production.
 *
 *   2. `CLERK_DEV_HMAC_TOKENS=true` (gated inside `verifyClerkSession`):
 *      keeps the legacy HMAC-SHA256 path so synthetic test tokens signed
 *      with `CLERK_SECRET_KEY` continue to verify. Refused at startup in
 *      production by `validateEnvSchema` and refused at runtime by
 *      `verifyClerkSession`.
 *
 * Hard-gated on NODE_ENV=dev. No-ops in every other environment.
 * Refuses to activate without an explicit DEV_AUTH_BYPASS=true flag
 * so no one accidentally ships it.
 */

const logger = createLogger({
  service: 'dev-auth-bypass',
  environment: process.env.NODE_ENV || 'dev',
});

interface DecodedClerkPayload {
  sub?: string;
  sid?: string;
  email?: string;
  exp?: number;
  azp?: string;
  [k: string]: unknown;
}

function decodeUnverified(token: string): DecodedClerkPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = Buffer.from(parts[1], 'base64url').toString('utf-8');
    return JSON.parse(payload) as DecodedClerkPayload;
  } catch {
    return null;
  }
}

/**
 * In-memory tenant store for dev. One tenant per Clerk user.
 * Implements just enough of TenantRepository for bootstrapTenant
 * to work without a real pool.
 */
export class DevInMemoryTenantRepository implements TenantRepository {
  private byOwner = new Map<string, Tenant>();

  async findByOwner(ownerId: string): Promise<Tenant | null> {
    return this.byOwner.get(ownerId) ?? null;
  }

  async findById(id: string): Promise<Tenant | null> {
    for (const t of this.byOwner.values()) if (t.id === id) return t;
    return null;
  }

  async create(data: { ownerId: string; ownerEmail: string; name: string }): Promise<Tenant> {
    const tenant: Tenant = {
      id: randomUUID(),
      ownerId: data.ownerId,
      ownerEmail: data.ownerEmail,
      name: data.name,
      createdAt: new Date(),
    };
    this.byOwner.set(data.ownerId, tenant);
    return tenant;
  }
}

export interface DevAuthBypassDeps {
  tenantRepo: TenantRepository;
}

export function isDevAuthBypassEnabled(): boolean {
  // Security-sensitive toggle — fail CLOSED. The bypass activates only for an
  // EXPLICIT dev NODE_ENV, never when NODE_ENV is unset/empty. This way a prod
  // box that somehow loses NODE_ENV cannot silently accept unsigned tokens even
  // if DEV_AUTH_BYPASS leaked into its environment. Local dev must set
  // NODE_ENV=dev|development (the same values config.ts validates as dev).
  const isDevEnv =
    process.env.NODE_ENV === 'dev' || process.env.NODE_ENV === 'development';
  return isDevEnv && process.env.DEV_AUTH_BYPASS === 'true';
}

export function devAuthBypass(deps: DevAuthBypassDeps) {
  return async (
    req: AuthenticatedRequest,
    _res: Response,
    next: NextFunction
  ): Promise<void> => {
    if (!isDevAuthBypassEnabled()) return next();
    if (req.auth) return next(); // already authed by verifyClerkSession

    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) return next();
    const token = authHeader.substring(7);

    const payload = decodeUnverified(token);
    if (!payload?.sub) {
      logger.warn('dev-auth-bypass: token had no sub claim');
      return next();
    }

    // Clerk session tokens usually don't carry email as a claim.
    // We synthesize one from the user id for bootstrap purposes —
    // the real email lives on Clerk's side and isn't needed locally.
    const email = typeof payload.email === 'string' ? payload.email : `${payload.sub}@dev.local`;

    try {
      // bootstrapTenant is idempotent — returns the existing tenant
      // if one exists for this owner, creates one otherwise.
      let tenant = await deps.tenantRepo.findByOwner(payload.sub);
      if (!tenant) {
        tenant = await deps.tenantRepo.create({
          ownerId: payload.sub,
          ownerEmail: email,
          name: `${email.split('@')[0]}'s dev workspace`,
        });
        logger.info('dev-auth-bypass: bootstrapped tenant for Clerk user', {
          userId: payload.sub,
          tenantId: tenant.id,
        });
      }

      // Honor an optional `role` claim so dev/verification can exercise
      // non-owner surfaces (e.g. a technician hitting appointments:view-only
      // routes). Defaults to owner; unknown values fall back to owner rather
      // than locking the dev session out of everything.
      const VALID_DEV_ROLES = ['owner', 'dispatcher', 'technician'];
      const claimedRole = typeof payload.role === 'string' ? payload.role : undefined;
      const role = claimedRole && VALID_DEV_ROLES.includes(claimedRole) ? claimedRole : 'owner';

      req.auth = {
        userId: payload.sub,
        sessionId: typeof payload.sid === 'string' ? payload.sid : 'dev-session',
        tenantId: tenant.id,
        role,
      };
      next();
    } catch (err) {
      logger.error('dev-auth-bypass: tenant bootstrap failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      next();
    }
  };
}
