import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../auth/clerk';
import { Permission, hasPermission, Role, isValidRole } from '../auth/rbac';
import { Mode } from '@ai-service-os/shared';
import { createLogger } from '../logging/logger';

const authzLogger = createLogger({
  service: 'authorization',
  environment: process.env.NODE_ENV || 'dev',
});

// P12-001 — `req.auth.mode` is set by `requireTenant` below. We avoid
// editing `auth/clerk.ts` (out of this story's scope: owned by the
// Clerk-verification seam) and instead use `(req.auth as AuthWithMode)`
// at the assignment point. Reads downstream go through the same shape.
type AuthWithMode = NonNullable<AuthenticatedRequest['auth']> & {
  mode?: 'supervisor' | 'tech' | 'both';
};

// ─────────────────────────────────────────────────────────────────────────────
// P12-001 — current_mode loader for requireTenant.
//
// `req.auth.mode` is the user's currently-selected operator mode
// ('supervisor' | 'tech' | 'both'). Downstream proposal routing (P12-004)
// will read this to decide whether to surface proposals interactively
// versus queue + SMS.
//
// We avoid pulling in a Pg repository here so the middleware module stays
// in the auth seam (no DB-layer deps). Instead, app.ts wires a loader
// function via setUserModeLoader; tests inject their own.
//
// 60s in-process cache keyed by user_id. Acceptable single-instance
// staleness; multi-instance deploys may see up to 60s skew on a mode
// switch. Risk-noted in the story body.
// ─────────────────────────────────────────────────────────────────────────────

export type UserModeLoader = (
  userId: string,
  tenantId: string,
) => Promise<Mode | null>;

const MODE_CACHE_TTL_MS = 60_000;
const modeCache = new Map<string, { mode: Mode; fetchedAt: number }>();

let userModeLoader: UserModeLoader | null = null;

/**
 * Wire the loader used by `requireTenant` to populate `req.auth.mode`.
 * Idempotent — safe to call once at boot. Tests use this to inject a
 * fake loader against an in-memory user map; production wires a Pg
 * loader against `users.current_mode`.
 */
export function setUserModeLoader(loader: UserModeLoader | null): void {
  userModeLoader = loader;
}

/** Test-only: clear the in-process cache so tests don't bleed into each other. */
export function clearUserModeCacheForTests(): void {
  modeCache.clear();
}

async function loadModeWithCache(
  userId: string,
  tenantId: string,
): Promise<Mode> {
  const now = Date.now();
  // P12-001 review fix — cache key is composite (tenantId + userId). The
  // same Clerk subject can belong to multiple tenants; keying by user
  // alone allowed a tenant-A mode to be reused for tenant-B for up to
  // 60s. Composite key prevents that cross-tenant bleed.
  const cacheKey = `${tenantId}::${userId}`;
  const cached = modeCache.get(cacheKey);
  if (cached && now - cached.fetchedAt < MODE_CACHE_TTL_MS) {
    return cached.mode;
  }
  let mode: Mode = 'supervisor';
  if (userModeLoader) {
    try {
      const loaded = await userModeLoader(userId, tenantId);
      if (loaded) mode = loaded;
    } catch {
      // Loader failures fall through to the supervisor default rather
      // than blowing up the request — a stale cache is preferable to a
      // hard auth-layer 500 on a transient DB blip.
      mode = cached?.mode ?? 'supervisor';
    }
  }
  modeCache.set(cacheKey, { mode, fetchedAt: now });
  return mode;
}

/** Test-only: prime the cache for a user (used by /api/me POST handler too). */
export function setCachedMode(
  userId: string,
  tenantId: string,
  mode: Mode,
): void {
  // P12-001 review fix — mirror the composite cache key used by
  // loadModeWithCache so a primed entry actually hits on next read.
  const cacheKey = `${tenantId}::${userId}`;
  modeCache.set(cacheKey, { mode, fetchedAt: Date.now() });
}

// ─────────────────────────────────────────────────────────────────────────────
// QUALITY-2026-07-12 WS4 — DB-authoritative authorization.
//
// The Clerk JWT proves *authentication* (who signed in) but is NOT trusted for
// *authorization*: its `role` / tenant-membership claims are minted at token
// time and go stale the moment an operator demotes, suspends, or removes a
// teammate. `resolveAuthorization` loads the caller's live membership row from
// the DB on every request and OVERWRITES `req.auth.role` with the DB role, so
// requirePermission / requireRole / enforceTenantIsolation downstream gate on
// the authoritative role. A demotion therefore takes effect on the NEXT request
// with no Clerk token refresh, and a deleted / suspended user is rejected even
// while holding a still-valid token.
//
// Wiring mirrors the userModeLoader seam above: app.ts injects a Pg-backed
// loader via setAuthorizationLoader so this module keeps zero DB-layer deps and
// stays unit-testable with a fake loader. When no loader is wired (no-DB dev /
// dev-auth-bypass) the JWT claim is used as-is — there is no DB to be
// authoritative over, and dev-bypass already trusts the token by design.
//
// PERFORMANCE / freshness: this adds one indexed lookup per request. We do NOT
// cache the result (unlike the 60s mode cache) — the whole point is that a
// role change is honored on the very next request, which a TTL cache would
// defeat. The lookup is keyed by the (tenant_id, clerk_user_id) index added in
// migration 248.
//
// FAIL CLOSED: a loader throw (DB down / transient error) denies the request
// with 503 rather than falling back to the JWT-claimed role. We never "default
// to a role" on the authorization path (contrast userModeLoader, which defaults
// to 'supervisor' because mode is not a security boundary).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A user's live, DB-authoritative membership for a tenant. `deleted` mirrors a
 * non-null `users.deleted_at`; `status` mirrors `users.status`
 * ('active' | 'suspended'). Access is granted only when NOT deleted and status
 * === 'active'.
 */
export interface MembershipRecord {
  role: string;
  deleted: boolean;
  status: string;
}

/**
 * Resolves the DB-authoritative membership for a Clerk subject within a tenant.
 * Returns `null` when no membership row exists for that user in that tenant.
 * MUST let infrastructure errors propagate (throw) so `resolveAuthorization`
 * can fail closed rather than silently trusting the token.
 */
export type AuthorizationLoader = (
  userId: string,
  tenantId: string,
) => Promise<MembershipRecord | null>;

let authorizationLoader: AuthorizationLoader | null = null;

/**
 * Wire the loader used by `resolveAuthorization`. Idempotent — called once at
 * boot. Not wiring it (no-DB dev / dev-auth-bypass) leaves authorization on the
 * JWT claim.
 */
export function setAuthorizationLoader(loader: AuthorizationLoader | null): void {
  authorizationLoader = loader;
}

/**
 * DB-authoritative authorization middleware. Mount after `requireAuth` so
 * `req.auth` is populated. Overwrites `req.auth.role` with the DB role and
 * rejects deleted / suspended / non-member callers. Fails closed on DB errors.
 */
export async function resolveAuthorization(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  // Defensive: requireAuth runs first, so req.auth is set in practice. If it
  // isn't, there is nothing to resolve — let the downstream gate 401.
  if (!req.auth) {
    next();
    return;
  }

  // No loader wired → no DB to be authoritative over (dev / dev-auth-bypass).
  // Keep the JWT claim.
  if (!authorizationLoader) {
    next();
    return;
  }

  // A token with no tenant context has no tenant-scoped membership to resolve.
  // Tenant-scoped routes are independently gated by requireTenant (403); leave
  // the claim untouched for the rare authenticated-but-tenantless request.
  if (!req.auth.tenantId) {
    next();
    return;
  }

  let membership: MembershipRecord | null;
  try {
    membership = await authorizationLoader(req.auth.userId, req.auth.tenantId);
  } catch (err) {
    // Fail closed: deny rather than trust the (possibly stale) token claim.
    authzLogger.error('Authorization resolution failed — failing closed', {
      reason: err instanceof Error ? err.message : String(err),
      userId: req.auth.userId,
      tenantId: req.auth.tenantId,
      path: req.path,
    });
    res.status(503).json({
      error: 'AUTHZ_UNAVAILABLE',
      message: 'Authorization service temporarily unavailable',
    });
    return;
  }

  if (!membership) {
    authzLogger.warn('Authorization denied — no membership row', {
      userId: req.auth.userId,
      tenantId: req.auth.tenantId,
      path: req.path,
    });
    res.status(403).json({
      error: 'FORBIDDEN',
      message: 'No active membership for this tenant',
    });
    return;
  }

  if (membership.deleted || membership.status !== 'active') {
    authzLogger.warn('Authorization denied — user not active', {
      userId: req.auth.userId,
      tenantId: req.auth.tenantId,
      deleted: membership.deleted,
      status: membership.status,
      path: req.path,
    });
    res.status(403).json({
      error: 'FORBIDDEN',
      message: 'User access has been revoked',
    });
    return;
  }

  // Authoritative: the DB role wins over the token claim. A stale token that
  // says 'owner' is enforced as whatever the DB now says.
  req.auth.role = membership.role;
  next();
}

export function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  if (!req.auth) {
    res.status(401).json({
      error: 'UNAUTHORIZED',
      message: 'Authentication required',
    });
    return;
  }
  next();
}

export async function requireTenant(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (!req.auth) {
    res.status(401).json({
      error: 'UNAUTHORIZED',
      message: 'Authentication required',
    });
    return;
  }
  if (!req.auth.tenantId) {
    res.status(403).json({
      error: 'FORBIDDEN',
      message: 'Tenant context required',
    });
    return;
  }
  // Attach req.auth.mode (default 'supervisor' if no loader / no row).
  // Defensive: never let a loader-layer error short-circuit auth.
  const auth = req.auth as AuthWithMode;
  try {
    auth.mode = await loadModeWithCache(auth.userId, auth.tenantId);
  } catch {
    auth.mode = 'supervisor';
  }
  next();
}

export function requirePermission(...permissions: Permission[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    if (!req.auth) {
      res.status(401).json({
        error: 'UNAUTHORIZED',
        message: 'Authentication required',
      });
      return;
    }

    const role = req.auth.role;
    if (!isValidRole(role)) {
      res.status(403).json({
        error: 'FORBIDDEN',
        message: 'Invalid role',
      });
      return;
    }

    const hasAll = permissions.every((p) => hasPermission(role as Role, p));
    if (!hasAll) {
      res.status(403).json({
        error: 'FORBIDDEN',
        message: 'Insufficient permissions',
      });
      return;
    }

    next();
  };
}

export function requireRole(...roles: Role[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    if (!req.auth) {
      res.status(401).json({
        error: 'UNAUTHORIZED',
        message: 'Authentication required',
      });
      return;
    }

    if (!roles.includes(req.auth.role as Role)) {
      res.status(403).json({
        error: 'FORBIDDEN',
        message: 'Insufficient role',
      });
      return;
    }

    next();
  };
}

export function enforceTenantIsolation(tenantIdParam: string = 'tenantId') {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    if (!req.auth) {
      res.status(401).json({
        error: 'UNAUTHORIZED',
        message: 'Authentication required',
      });
      return;
    }

    const requestedTenantId = req.params[tenantIdParam] || req.body?.tenantId;
    if (requestedTenantId && requestedTenantId !== req.auth.tenantId) {
      res.status(403).json({
        error: 'FORBIDDEN',
        message: 'Cross-tenant access denied',
      });
      return;
    }

    // Ensure tenant context is always set from authenticated user
    if (!req.body) req.body = {};
    req.body.tenantId = req.auth.tenantId;

    next();
  };
}
