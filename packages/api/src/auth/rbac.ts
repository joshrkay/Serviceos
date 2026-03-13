export type Role = 'owner' | 'dispatcher' | 'technician';

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
  | 'proposals:view';

const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  owner: [
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
    'proposals:view',
  ],
  dispatcher: [
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
    'proposals:view',
  ],
  technician: [
    'jobs:view',
    'jobs:update',
    'conversations:view',
    'conversations:create',
    'files:upload',
    'files:view',
    'proposals:view',
  ],
};

export function hasPermission(role: Role, permission: Permission): boolean {
  const permissions = ROLE_PERMISSIONS[role];
  if (!permissions) {
    return false;
  }
  return permissions.includes(permission);
}

export function getPermissions(role: Role): Permission[] {
  return ROLE_PERMISSIONS[role] || [];
}

export function isValidRole(role: string): role is Role {
  return ['owner', 'dispatcher', 'technician'].includes(role);
}

export interface PermissionContract {
  role: Role;
  permissions: Permission[];
}

export function getPermissionContract(): PermissionContract[] {
  return (Object.keys(ROLE_PERMISSIONS) as Role[]).map((role) => ({
    role,
    permissions: ROLE_PERMISSIONS[role],
  }));
}
