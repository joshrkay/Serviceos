import { ValidationError } from '../shared/errors';

/**
 * Tier 4 (Team members — PR 1). User model + repository for the team
 * roster surfaced on Settings → Team members. Reads from the existing
 * `users` table (migration 002 + 063). Writes are limited in PR 1 to
 * what the role-edit + invite flows in PR 2/3 will consume:
 *
 *   - PR 1: list (this PR) + findById.
 *   - PR 2: updateRole (role enum is the same one validated in
 *           migration 002).
 *   - PR 3: create (invitation flow; clerk_user_id populated when
 *           the invitee accepts and Clerk fires the user.created
 *           webhook).
 */

export type UserRole = 'owner' | 'dispatcher' | 'technician';

export const USER_ROLES: ReadonlyArray<UserRole> = ['owner', 'dispatcher', 'technician'];

export interface User {
  id: string;
  tenantId: string;
  /** Clerk subject (sub claim). Nullable so we can persist invited
   *  users before they've accepted and Clerk has minted them a
   *  user_id. */
  clerkUserId?: string | null;
  email: string;
  role: UserRole;
  firstName?: string;
  lastName?: string;
  /** Phase 12 — owners + dispatchers who can switch to tech mode. */
  canFieldServe: boolean;
  /**
   * P1-022 — normalized E.164 mobile number (`+15551234567`) used to bind
   * an inbound communication (tech SMS reply, emergency owner-cell paging)
   * to this user. Stored normalized; always pass raw input through
   * `normalizeMobileE164()` before writing or looking up. Optional —
   * existing rows have no mobile on file.
   */
  mobileNumber?: string;
  /**
   * 16D soft-delete stamp (migration 093). Non-null means the account is
   * deleted: auth rejects it (authorization-loader) and repository reads
   * exclude it. Rows are retained — never purged — for audit and billing.
   */
  deletedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface UserListOptions {
  /** Filter by role; omit to return every user in the tenant. */
  role?: UserRole;
  /** Cap the number of rows returned. Omit to return every matching row. */
  limit?: number;
}

export interface UpdateUserInput {
  role?: UserRole;
  firstName?: string;
  lastName?: string;
  canFieldServe?: boolean;
}

export interface UserRepository {
  findByTenant(tenantId: string, options?: UserListOptions): Promise<User[]>;
  findById(tenantId: string, id: string): Promise<User | null>;
  /**
   * P1-022 — bind an inbound communication to a user by mobile number.
   * `e164` MUST already be normalized via `normalizeMobileE164()`. Always
   * tenant-scoped (the tenantId is enforced in the WHERE clause as defense
   * in depth alongside RLS) so a number registered in one tenant can never
   * resolve a user in another. Returns null when no user in this tenant has
   * that mobile on file.
   */
  findByMobileNumber(tenantId: string, e164: string): Promise<User | null>;
  /**
   * Set or clear (`null`) a user's mobile number. `e164` MUST already be
   * normalized via `normalizeMobileE164()`. Tenant-scoped; throws a Postgres
   * `23505` unique violation when another user in the tenant already holds the
   * number (the route surfaces that as a 409). Returns the updated row, or
   * null when the user wasn't found in this tenant.
   */
  setMobileNumber(tenantId: string, id: string, e164: string | null): Promise<User | null>;
  update(tenantId: string, id: string, updates: UpdateUserInput): Promise<User | null>;
  /**
   * Tier 4 (Team members — PR 2 follow-up). Atomic role demotion that
   * preserves the "at least one owner per tenant" invariant under
   * concurrent updates. Only succeeds when there's another owner on
   * the same tenant at UPDATE time. Returns the updated row, or
   * null when the guard blocked the update (the only-owner case)
   * or the user wasn't found.
   *
   * Used for owner→{dispatcher,technician} transitions. All other
   * updates go through `update`. Pg implementation does this in a
   * single statement (UPDATE ... WHERE EXISTS (SELECT another owner));
   * InMemory fakes can fall back to the read-then-write path because
   * Node serializes their access.
   */
  demoteOwnerIfAnotherExists?(
    tenantId: string,
    id: string,
    newRole: 'dispatcher' | 'technician',
  ): Promise<User | null>;
  /**
   * Guideline 5.1.1(v) — in-app account deletion. Soft-deletes the user's own
   * row (stamps `deleted_at`, per the 16D retention model: data is kept for
   * audit/billing, access is revoked). Atomic last-owner guard: when the
   * target is an owner, the update only succeeds if ANOTHER non-deleted owner
   * exists in the tenant — a tenant must never become ownerless. Returns the
   * deleted row, or null when the row wasn't found, was already deleted, or
   * the guard blocked the sole owner.
   */
  softDeleteSelf(tenantId: string, id: string): Promise<User | null>;
  /**
   * Compensating action for `softDeleteSelf` when the follow-up Clerk
   * deletion fails: un-stamps `deleted_at` and re-instates the mobile
   * number (`softDeleteSelf` clears it to release the
   * `users_mobile_unique` slot). Only touches a row that is currently
   * deleted. Returns the restored row or null if nothing matched.
   */
  restoreAccount(tenantId: string, id: string, mobileNumber: string | null): Promise<User | null>;
  /** Test/dev helper. Production user creation goes through the Clerk webhook. */
  create?(user: Omit<User, 'createdAt' | 'updatedAt'>): Promise<User>;
}

export function validateUpdateUserInput(input: UpdateUserInput): string[] {
  const errors: string[] = [];
  if (input.role && !USER_ROLES.includes(input.role)) {
    errors.push(`Invalid role: ${input.role}`);
  }
  if (input.firstName !== undefined && input.firstName.length > 200) {
    errors.push('firstName must be 200 characters or fewer');
  }
  if (input.lastName !== undefined && input.lastName.length > 200) {
    errors.push('lastName must be 200 characters or fewer');
  }
  return errors;
}

export async function listUsers(
  tenantId: string,
  repository: UserRepository,
  options?: UserListOptions,
): Promise<User[]> {
  if (!tenantId) throw new ValidationError('tenantId is required');
  return repository.findByTenant(tenantId, options);
}

export async function updateUser(
  tenantId: string,
  id: string,
  input: UpdateUserInput,
  repository: UserRepository,
): Promise<User | null> {
  const errors = validateUpdateUserInput(input);
  if (errors.length > 0) {
    throw new ValidationError(`Validation failed: ${errors.join(', ')}`);
  }

  // Tier 4 (Team members — PR 2). Last-owner guard: changing the
  // role of the only owner away from 'owner' would lock the tenant
  // out of users:edit_role + users:invite forever. Refuse — the
  // operator must promote someone else first.
  //
  // Race-safety (PR 319 review): two concurrent demotions of two
  // different owners can both observe `owners.length > 1` in the
  // pre-check below and each succeed, leaving the tenant with zero
  // owners. The atomic demoteOwnerIfAnotherExists path closes that
  // window in the Pg implementation by enforcing the guard inside a
  // single SQL statement (UPDATE ... WHERE EXISTS (SELECT another
  // owner)). The pre-check stays as a fast user-facing error path
  // (returns the friendly message before the SQL fires); the atomic
  // path is the actual safety net.
  if (input.role && (input.role === 'dispatcher' || input.role === 'technician')) {
    const target = await repository.findById(tenantId, id);
    if (target?.role === 'owner') {
      const owners = await repository.findByTenant(tenantId, { role: 'owner' });
      if (owners.length <= 1) {
        throw new ValidationError(
          'Cannot demote the only owner — promote another team member first',
        );
      }
      if (repository.demoteOwnerIfAnotherExists) {
        const updated = await repository.demoteOwnerIfAnotherExists(
          tenantId,
          id,
          input.role,
        );
        if (!updated) {
          // The atomic guard rejected: between the pre-check above and
          // this UPDATE, another concurrent request demoted the other
          // owner. Surface the same friendly error.
          throw new ValidationError(
            'Cannot demote the only owner — promote another team member first',
          );
        }
        // Fall through to the regular update for any non-role fields.
        const { role: _droppedRole, ...rest } = input;
        if (Object.keys(rest).length === 0) return updated;
        return repository.update(tenantId, id, rest);
      }
    }
  }

  return repository.update(tenantId, id, input);
}

export class InMemoryUserRepository implements UserRepository {
  private users: Map<string, User> = new Map();

  async findByTenant(tenantId: string, options?: UserListOptions): Promise<User[]> {
    // Deleted accounts are invisible to reads (mirrors `deleted_at IS NULL`
    // in the Pg implementation).
    const all = Array.from(this.users.values()).filter(
      (u) => u.tenantId === tenantId && !u.deletedAt,
    );
    const filtered = options?.role ? all.filter((u) => u.role === options.role) : all;
    // Stable order — must match the pg implementation's `ORDER BY created_at
    // ASC` so a SQL `LIMIT` window and this in-memory `.slice` agree.
    const sorted = filtered.slice().sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const bounded = options?.limit !== undefined ? sorted.slice(0, Math.max(0, options.limit)) : sorted;
    return bounded.map((u) => ({ ...u }));
  }

  async findById(tenantId: string, id: string): Promise<User | null> {
    const u = this.users.get(id);
    if (!u || u.tenantId !== tenantId || u.deletedAt) return null;
    return { ...u };
  }

  async findByMobileNumber(tenantId: string, e164: string): Promise<User | null> {
    const match = Array.from(this.users.values()).find(
      (u) => u.tenantId === tenantId && u.mobileNumber === e164 && !u.deletedAt,
    );
    return match ? { ...match } : null;
  }

  async softDeleteSelf(tenantId: string, id: string): Promise<User | null> {
    const u = this.users.get(id);
    if (!u || u.tenantId !== tenantId || u.deletedAt) return null;
    if (u.role === 'owner') {
      const anotherOwner = Array.from(this.users.values()).some(
        (other) =>
          other.tenantId === tenantId &&
          other.id !== id &&
          other.role === 'owner' &&
          !other.deletedAt,
      );
      if (!anotherOwner) return null;
    }
    // Clear the mobile number so the `(tenant_id, mobile_number)` uniqueness
    // slot is released for live accounts (mirrors the Pg implementation).
    const next: User = {
      ...u,
      mobileNumber: undefined,
      deletedAt: new Date(),
      updatedAt: new Date(),
    };
    this.users.set(id, next);
    return { ...next };
  }

  async restoreAccount(
    tenantId: string,
    id: string,
    mobileNumber: string | null,
  ): Promise<User | null> {
    const u = this.users.get(id);
    if (!u || u.tenantId !== tenantId || !u.deletedAt) return null;
    const next: User = {
      ...u,
      deletedAt: null,
      mobileNumber: mobileNumber ?? undefined,
      updatedAt: new Date(),
    };
    this.users.set(id, next);
    return { ...next };
  }

  async setMobileNumber(
    tenantId: string,
    id: string,
    e164: string | null,
  ): Promise<User | null> {
    const u = this.users.get(id);
    if (!u || u.tenantId !== tenantId) return null;
    if (e164 !== null) {
      // Mirror the Pg `(tenant_id, mobile_number)` partial-unique index so a
      // second teammate can't claim a number already on file in this tenant.
      const clash = Array.from(this.users.values()).find(
        (other) =>
          other.tenantId === tenantId && other.id !== id && other.mobileNumber === e164,
      );
      if (clash) {
        const err = new Error('duplicate key value violates unique constraint') as Error & {
          code: string;
        };
        err.code = '23505';
        throw err;
      }
    }
    const next: User = { ...u, mobileNumber: e164 ?? undefined, updatedAt: new Date() };
    this.users.set(id, next);
    return { ...next };
  }

  async update(tenantId: string, id: string, updates: UpdateUserInput): Promise<User | null> {
    const u = this.users.get(id);
    if (!u || u.tenantId !== tenantId) return null;
    const next: User = {
      ...u,
      role: updates.role ?? u.role,
      firstName: updates.firstName ?? u.firstName,
      lastName: updates.lastName ?? u.lastName,
      canFieldServe: updates.canFieldServe ?? u.canFieldServe,
      updatedAt: new Date(),
    };
    this.users.set(id, next);
    return { ...next };
  }

  async create(user: Omit<User, 'createdAt' | 'updatedAt'>): Promise<User> {
    const now = new Date();
    const created: User = { ...user, createdAt: now, updatedAt: now };
    this.users.set(created.id, created);
    return { ...created };
  }
}
