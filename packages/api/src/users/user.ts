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
  createdAt: Date;
  updatedAt: Date;
}

export interface UserListOptions {
  /** Filter by role; omit to return every user in the tenant. */
  role?: UserRole;
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
  update(tenantId: string, id: string, updates: UpdateUserInput): Promise<User | null>;
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
  return repository.update(tenantId, id, input);
}

export class InMemoryUserRepository implements UserRepository {
  private users: Map<string, User> = new Map();

  async findByTenant(tenantId: string, options?: UserListOptions): Promise<User[]> {
    const all = Array.from(this.users.values()).filter((u) => u.tenantId === tenantId);
    const filtered = options?.role ? all.filter((u) => u.role === options.role) : all;
    return filtered
      .slice()
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((u) => ({ ...u }));
  }

  async findById(tenantId: string, id: string): Promise<User | null> {
    const u = this.users.get(id);
    if (!u || u.tenantId !== tenantId) return null;
    return { ...u };
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
