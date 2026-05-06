import { describe, it, expect, beforeEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import {
  InMemoryUserRepository,
  listUsers,
  updateUser,
  validateUpdateUserInput,
  User,
} from '../../src/users/user';

const TENANT = 'tenant-team-1';

function seedUser(repo: InMemoryUserRepository, overrides: Partial<User> = {}): Promise<User> {
  return repo.create!({
    id: uuidv4(),
    tenantId: TENANT,
    clerkUserId: `user_${Math.random()}`,
    email: 'jane@example.com',
    role: 'technician',
    canFieldServe: false,
    ...overrides,
  });
}

describe('users — Tier 4 Team members (PR 1: read + role-edit primitives)', () => {
  let repo: InMemoryUserRepository;
  beforeEach(() => {
    repo = new InMemoryUserRepository();
  });

  it('listUsers returns every user in the tenant ordered by createdAt', async () => {
    await seedUser(repo, { id: 'u1', email: 'a@example.com' });
    await seedUser(repo, { id: 'u2', email: 'b@example.com', role: 'owner' });
    const list = await listUsers(TENANT, repo);
    expect(list.map((u) => u.id)).toEqual(['u1', 'u2']);
  });

  it('listUsers filters by role when supplied', async () => {
    await seedUser(repo, { id: 'u1', email: 'tech@example.com', role: 'technician' });
    await seedUser(repo, { id: 'u2', email: 'owner@example.com', role: 'owner' });
    const list = await listUsers(TENANT, repo, { role: 'technician' });
    expect(list).toHaveLength(1);
    expect(list[0].role).toBe('technician');
  });

  it('listUsers excludes other tenants', async () => {
    await seedUser(repo, { id: 'u1' });
    await seedUser(repo, { id: 'u2', tenantId: 'tenant-other' });
    const list = await listUsers(TENANT, repo);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('u1');
  });

  it('updateUser changes role', async () => {
    const u = await seedUser(repo);
    const updated = await updateUser(TENANT, u.id, { role: 'dispatcher' }, repo);
    expect(updated?.role).toBe('dispatcher');
  });

  it('updateUser rejects an unknown role', async () => {
    const u = await seedUser(repo);
    await expect(
      updateUser(TENANT, u.id, { role: 'admin' as never }, repo),
    ).rejects.toThrow(/Invalid role/);
  });

  it('updateUser returns null when the user does not exist in the tenant', async () => {
    const result = await updateUser(TENANT, 'missing-id', { role: 'owner' }, repo);
    expect(result).toBeNull();
  });

  it('validateUpdateUserInput accepts valid roles', () => {
    expect(validateUpdateUserInput({ role: 'owner' })).toEqual([]);
    expect(validateUpdateUserInput({ role: 'dispatcher' })).toEqual([]);
    expect(validateUpdateUserInput({ role: 'technician' })).toEqual([]);
  });

  it('validateUpdateUserInput caps name lengths', () => {
    const long = 'x'.repeat(201);
    expect(validateUpdateUserInput({ firstName: long })).toContain(
      'firstName must be 200 characters or fewer',
    );
  });
});
