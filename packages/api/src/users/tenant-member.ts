/**
 * #1463 — the single "is this user an assignable member of this tenant?"
 * lookup every assignee-style write goes through.
 *
 * An assignee must be a row in THIS tenant's `users` table (the repository
 * read is tenant-scoped), not soft-deleted, and in the `active` access state
 * (migration 248 — `resolveAuthorization` grants a suspended member nothing,
 * so they cannot be handed work either).
 *
 * Callers must refuse with ONE message whatever the cause — another
 * tenant's user, a suspended member, and a uuid naming nobody are
 * indistinguishable to the caller, so the API is no cross-tenant
 * existence oracle.
 */
import type { User, UserRepository } from './user';
import { ValidationError } from '../shared/errors';

/** Not soft-deleted and in the `active` access state (undefined ⇒ active, the column default). */
export function isActiveMember(user: Pick<User, 'deletedAt' | 'status'>): boolean {
  return !user.deletedAt && (user.status ?? 'active') === 'active';
}

export async function findActiveTenantMember(
  userRepo: Pick<UserRepository, 'findById'>,
  tenantId: string,
  userId: string,
): Promise<User | null> {
  const user = await userRepo.findById(tenantId, userId);
  if (!user || user.tenantId !== tenantId || !isActiveMember(user)) return null;
  return user;
}

/** Throws a 400 ValidationError naming `field` unless `userId` is an active member. */
export async function requireActiveTenantMember(
  userRepo: Pick<UserRepository, 'findById'>,
  tenantId: string,
  userId: string,
  field: string,
): Promise<User> {
  const user = await findActiveTenantMember(userRepo, tenantId, userId);
  if (!user) {
    throw new ValidationError(`${field} must reference an active member of this tenant`, { field });
  }
  return user;
}

/**
 * Technician assignment: an active member of this tenant whose role is
 * `technician`. One message for every refusal (see file header).
 */
export async function requireActiveTechnician(
  userRepo: Pick<UserRepository, 'findById'>,
  tenantId: string,
  technicianId: string,
): Promise<User> {
  const user = await findActiveTenantMember(userRepo, tenantId, technicianId);
  if (!user || user.role !== 'technician') {
    throw new ValidationError(
      'technicianId must reference an active member of this tenant with the technician role',
      { field: 'technicianId' },
    );
  }
  return user;
}
