// ── RBAC Permissions ──
// Canonical permission types, role mappings, and helper functions.
// Used across API middleware, proposal actions, and frontend guards.

import { Role } from './enums';

export type Permission =
  | 'tenant:manage'
  | 'users:invite'
  | 'users:remove'
  | 'users:list'
  | 'jobs:create'
  | 'jobs:assign'
  | 'jobs:view'
  | 'jobs:update'
  | 'jobs:delete'
  | 'conversations:view'
  | 'conversations:create'
  | 'conversations:manage'
  | 'files:upload'
  | 'files:view'
  | 'files:delete'
  | 'ai:run'
  | 'ai:configure'
  | 'audit:view'
  | 'reports:view'
  | 'proposals:approve'
  | 'proposals:edit'
  | 'proposals:view'
  | 'customers:create'
  | 'customers:view'
  | 'customers:update'
  | 'customers:delete'
  | 'locations:create'
  | 'locations:view'
  | 'locations:update'
  | 'locations:delete'
  | 'estimates:create'
  | 'estimates:view'
  | 'estimates:update'
  | 'estimates:delete'
  | 'estimates:approve'
  | 'invoices:create'
  | 'invoices:view'
  | 'invoices:update'
  | 'invoices:delete'
  | 'payments:create'
  | 'payments:view'
  | 'appointments:create'
  | 'appointments:view'
  | 'appointments:update'
  | 'appointments:delete'
  | 'notes:create'
  | 'notes:view'
  | 'notes:update'
  | 'notes:delete'
  | 'settings:view'
  | 'settings:update';

const ROLE_PERMISSIONS: Record<string, Permission[]> = {
  [Role.OWNER]: [
    'tenant:manage',
    'users:invite',
    'users:remove',
    'users:list',
    'jobs:create',
    'jobs:assign',
    'jobs:view',
    'jobs:update',
    'jobs:delete',
    'conversations:view',
    'conversations:create',
    'conversations:manage',
    'files:upload',
    'files:view',
    'files:delete',
    'ai:run',
    'ai:configure',
    'audit:view',
    'reports:view',
    'proposals:approve',
    'proposals:edit',
    'proposals:view',
    'customers:create',
    'customers:view',
    'customers:update',
    'customers:delete',
    'locations:create',
    'locations:view',
    'locations:update',
    'locations:delete',
    'estimates:create',
    'estimates:view',
    'estimates:update',
    'estimates:delete',
    'estimates:approve',
    'invoices:create',
    'invoices:view',
    'invoices:update',
    'invoices:delete',
    'payments:create',
    'payments:view',
    'appointments:create',
    'appointments:view',
    'appointments:update',
    'appointments:delete',
    'notes:create',
    'notes:view',
    'notes:update',
    'notes:delete',
    'settings:view',
    'settings:update',
  ],
  [Role.DISPATCHER]: [
    'users:list',
    'jobs:create',
    'jobs:assign',
    'jobs:view',
    'jobs:update',
    'conversations:view',
    'conversations:create',
    'conversations:manage',
    'files:upload',
    'files:view',
    'ai:run',
    'reports:view',
    'proposals:approve',
    'proposals:edit',
    'proposals:view',
    'customers:create',
    'customers:view',
    'customers:update',
    'locations:create',
    'locations:view',
    'locations:update',
    'estimates:create',
    'estimates:view',
    'estimates:update',
    'invoices:create',
    'invoices:view',
    'invoices:update',
    'payments:create',
    'payments:view',
    'appointments:create',
    'appointments:view',
    'appointments:update',
    'notes:create',
    'notes:view',
    'notes:update',
    'settings:view',
  ],
  [Role.TECHNICIAN]: [
    'jobs:view',
    'jobs:update',
    'conversations:view',
    'conversations:create',
    'files:upload',
    'files:view',
    'proposals:view',
    'customers:view',
    'locations:view',
    'estimates:view',
    'invoices:view',
    'payments:view',
    'appointments:view',
    'notes:create',
    'notes:view',
  ],
};

export function hasPermission(role: Role | string, permission: Permission): boolean {
  const permissions = ROLE_PERMISSIONS[role];
  if (!permissions) {
    return false;
  }
  return permissions.includes(permission);
}

export function getPermissions(role: Role | string): Permission[] {
  return ROLE_PERMISSIONS[role] || [];
}

export function isValidRole(role: string): role is Role {
  return Object.values(Role).includes(role as Role);
}

export interface PermissionContract {
  role: Role;
  permissions: Permission[];
}

export function getPermissionContract(): PermissionContract[] {
  return Object.values(Role).map((role) => ({
    role,
    permissions: ROLE_PERMISSIONS[role],
  }));
}
