export type Role = 'owner' | 'dispatcher' | 'technician';

export type Permission =
  | 'tenant:manage'
  | 'users:invite'
  | 'users:remove'
  | 'users:list'
  // Tier 4 (Team members — PR 2). Edit a teammate's role / display
  // name / can_field_serve flag. Owner-only to keep dispatchers from
  // demoting the owner or escalating their own role.
  | 'users:edit_role'
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
  | 'proposals:create'
  | 'proposals:edit'
  | 'proposals:view'
  // Phase 1 permissions
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
  | 'settings:update'
  // Phase 6 permissions
  | 'dispatch:view'
  | 'dispatch:manage'
  | 'availability:view'
  | 'availability:manage'
  // Voice training assets — gated separately from generic `settings:update`
  // so an org can later carve out a compliance-only role that approves /
  // activates / archives without granting full settings edit.
  | 'vertical_training_assets:approve'
  // RV-005 — portal visibility is owner-only; technicians and dispatchers
  // cannot control what customers see in the portal.
  | 'attachments:visibility';

const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  owner: [
    'tenant:manage',
    'users:invite',
    'users:remove',
    'users:list',
    'users:edit_role',
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
    'proposals:create',
    'proposals:edit',
    'proposals:view',
    // Phase 1
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
    // Phase 6
    'dispatch:view',
    'dispatch:manage',
    'availability:view',
    'availability:manage',
    'vertical_training_assets:approve',
    'attachments:visibility',
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
    'proposals:create',
    'proposals:edit',
    'proposals:view',
    // Phase 1
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
    // Phase 6
    'dispatch:view',
    'dispatch:manage',
    'availability:view',
    'availability:manage',
  ],
  technician: [
    'jobs:view',
    'jobs:update',
    'conversations:view',
    'conversations:create',
    'files:upload',
    'files:view',
    // Technicians deliberately lack appointments:update — the day-view
    // reschedule flow (TechnicianDayView.saveAppointmentTimes) routes edits
    // through the human-approval-gated proposal path instead, so creating a
    // proposal is the LOW-privilege action here and must stay available.
    'proposals:create',
    'proposals:view',
    // Phase 1
    'customers:view',
    'locations:view',
    // Epic 6 / non-goal: technicians must not see office/billing surfaces.
    // estimates:view, invoices:view, and payments:view are intentionally
    // withheld (see notifications/user-targeting.ts — billing pushes target
    // permission-holders, "never a technician's device"). The field surfaces
    // (TechJobView, TechnicianDayView) read only jobs/notes/appointments.
    'appointments:view',
    'notes:create',
    'notes:view',
    // Phase 6
    'availability:view',
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
