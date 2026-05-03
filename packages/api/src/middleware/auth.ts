import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../auth/clerk';
import { Permission, hasPermission, Role, isValidRole } from '../auth/rbac';

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

export type Mode = 'supervisor' | 'tech' | 'both';

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
  const cached = modeCache.get(userId);
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
  modeCache.set(userId, { mode, fetchedAt: now });
  return mode;
}

/** Test-only: prime the cache for a user (used by /api/me POST handler too). */
export function setCachedMode(userId: string, mode: Mode): void {
  modeCache.set(userId, { mode, fetchedAt: Date.now() });
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
