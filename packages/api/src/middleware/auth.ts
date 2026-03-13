import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../auth/clerk';
import { Permission, hasPermission, Role, isValidRole } from '../auth/rbac';

// ── requireAuth ───────────────────────────────────────────────────────────────
//
// Rejects requests with no verified Clerk session.
// Must run after clerkAuthMiddleware() + extractAuthContext().

export function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  if (!req.auth?.userId) {
    res.status(401).json({ error: 'UNAUTHORIZED', message: 'Authentication required' });
    return;
  }
  next();
}

// ── requireTenant ─────────────────────────────────────────────────────────────
//
// Rejects requests where the JWT has no tenant_id claim.
// This means the JWT template is not configured or the user hasn't
// completed tenant bootstrap yet.

export function requireTenant(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  if (!req.auth?.userId) {
    res.status(401).json({ error: 'UNAUTHORIZED', message: 'Authentication required' });
    return;
  }
  if (!req.auth.tenantId) {
    res.status(403).json({
      error: 'FORBIDDEN',
      message: 'Tenant context required — ensure JWT template is configured in Clerk dashboard',
    });
    return;
  }
  next();
}

// ── requirePermission ─────────────────────────────────────────────────────────

export function requirePermission(...permissions: Permission[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    if (!req.auth?.userId) {
      res.status(401).json({ error: 'UNAUTHORIZED', message: 'Authentication required' });
      return;
    }

    const role = req.auth.role;
    if (!isValidRole(role)) {
      res.status(403).json({ error: 'FORBIDDEN', message: 'Invalid role' });
      return;
    }

    const hasAll = permissions.every((p) => hasPermission(role as Role, p));
    if (!hasAll) {
      res.status(403).json({ error: 'FORBIDDEN', message: 'Insufficient permissions' });
      return;
    }

    next();
  };
}

// ── requireRole ───────────────────────────────────────────────────────────────

export function requireRole(...roles: Role[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    if (!req.auth?.userId) {
      res.status(401).json({ error: 'UNAUTHORIZED', message: 'Authentication required' });
      return;
    }
    if (!roles.includes(req.auth.role as Role)) {
      res.status(403).json({ error: 'FORBIDDEN', message: 'Insufficient role' });
      return;
    }
    next();
  };
}

// ── enforceTenantIsolation ────────────────────────────────────────────────────
//
// Prevents cross-tenant access by checking that any tenantId in the
// request params/body matches the authenticated user's tenant.

export function enforceTenantIsolation(tenantIdParam: string = 'tenantId') {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    if (!req.auth?.userId) {
      res.status(401).json({ error: 'UNAUTHORIZED', message: 'Authentication required' });
      return;
    }

    const requestedTenantId =
      req.params[tenantIdParam] ??
      (req.body as Record<string, unknown>)?.[tenantIdParam];

    // Only validate if a tenantId is explicitly present in the request
    if (requestedTenantId && requestedTenantId !== req.auth.tenantId) {
      res.status(403).json({ error: 'FORBIDDEN', message: 'Cross-tenant access denied' });
      return;
    }

    next();
  };
}
