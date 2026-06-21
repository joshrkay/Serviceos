import { hasPermission, type Permission } from '../auth/rbac';
import { type UserRepository } from '../users/user';

/**
 * Resolve the set of Clerk user ids in a tenant whose role grants a given
 * permission. Device tokens are keyed by `userId` (the Clerk subject), so the
 * owner-notification service uses this to target only the devices of users who
 * should receive a given notification type (e.g. a payment push goes to whoever
 * holds `payments:view`, never a technician's device).
 *
 * Generalizes the proposal-specific `approverUserIdsResolver` to any permission.
 */
export function userIdsWithPermissionResolver(
  userRepo: Pick<UserRepository, 'findByTenant'>,
): (tenantId: string, permission: Permission) => Promise<Set<string>> {
  return async (tenantId: string, permission: Permission): Promise<Set<string>> => {
    const users = await userRepo.findByTenant(tenantId);
    const ids = new Set<string>();
    for (const u of users) {
      if (u.clerkUserId && hasPermission(u.role, permission)) {
        ids.add(u.clerkUserId);
      }
    }
    return ids;
  };
}
