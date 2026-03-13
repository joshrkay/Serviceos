import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../auth/clerk';
import { Permission, hasPermission, Role, isValidRole } from '../auth/rbac';

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

export function requireTenant(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
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

    next();
  };
}
