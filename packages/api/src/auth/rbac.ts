// Re-export RBAC types and functions from the shared package.
// Canonical definitions live in @ai-service-os/shared/permissions.
export {
  hasPermission,
  getPermissions,
  isValidRole,
  getPermissionContract,
} from '@ai-service-os/shared';
export type {
  Permission,
  PermissionContract,
} from '@ai-service-os/shared';

// Backward-compatible Role type — accepts both enum values and string literals.
// The shared package exports Role as an enum; this alias keeps existing API code
// that uses string literals (e.g. 'owner') working without changes.
export type Role = 'owner' | 'dispatcher' | 'technician';
