import { describe, it, expect, beforeEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import {
  InMemoryUserRepository,
  listUsers,
  updateUser,
  validateUpdateUserInput,
  resolveCanonicalUser,
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

  it('updateUser refuses to demote the only owner', async () => {
    const owner = await seedUser(repo, { id: 'owner-only', role: 'owner' });
    await expect(
      updateUser(TENANT, owner.id, { role: 'dispatcher' }, repo),
    ).rejects.toThrow(/only owner/);
  });

  it('updateUser allows demoting an owner when another owner exists', async () => {
    const a = await seedUser(repo, { id: 'owner-a', role: 'owner' });
    await seedUser(repo, { id: 'owner-b', role: 'owner' });
    const updated = await updateUser(TENANT, a.id, { role: 'dispatcher' }, repo);
    expect(updated?.role).toBe('dispatcher');
  });

  describe('findByTenant limit', () => {
    beforeEach(async () => {
      // createdAt ascending u0..u4 — findByTenant sorts by createdAt ASC.
      for (let i = 0; i < 5; i++) {
        await seedUser(repo, { id: `u${i}`, email: `u${i}@example.com` });
      }
    });

    it('returns N of M rows when a limit is given', async () => {
      const list = await listUsers(TENANT, repo, { limit: 2 });
      expect(list.map((u) => u.id)).toEqual(['u0', 'u1']);
    });

    it('returns every row when limit is omitted (backward compat)', async () => {
      const list = await listUsers(TENANT, repo);
      expect(list).toHaveLength(5);
    });

    it('composes with the role filter', async () => {
      await seedUser(repo, { id: 'owner-1', role: 'owner' });
      const list = await listUsers(TENANT, repo, { role: 'technician', limit: 2 });
      expect(list.map((u) => u.id)).toEqual(['u0', 'u1']);
      expect(list.every((u) => u.role === 'technician')).toBe(true);
    });

    it('limit 0 returns no rows', async () => {
      const list = await listUsers(TENANT, repo, { limit: 0 });
      expect(list).toEqual([]);
    });

    it('limit greater than the row count returns all rows', async () => {
      const list = await listUsers(TENANT, repo, { limit: 1000 });
      expect(list).toHaveLength(5);
    });
  });
});

// (2026-08-09, Task 10 quality-review I7) — moved here from
// dispatch/en-route-voice.ts (named `resolveCanonicalTechnician` there),
// which had NO direct test — only indirect coverage via en_route's
// integration tests. First direct coverage for the dual-check.
describe('resolveCanonicalUser', () => {
  let repo: InMemoryUserRepository;
  beforeEach(() => {
    repo = new InMemoryUserRepository();
  });

  it('matches on clerkUserId (the common case — voice_recordings.created_by / req.auth.userId)', async () => {
    const created = await seedUser(repo, { clerkUserId: 'clerk_abc123' });
    const found = await resolveCanonicalUser(repo, TENANT, 'clerk_abc123');
    expect(found?.id).toBe(created.id);
  });

  it('falls back to matching on the canonical users.id', async () => {
    const created = await seedUser(repo, { id: 'internal-id-1', clerkUserId: 'clerk_other' });
    const found = await resolveCanonicalUser(repo, TENANT, 'internal-id-1');
    expect(found?.id).toBe('internal-id-1');
  });

  it('returns null when nothing matches', async () => {
    await seedUser(repo, { clerkUserId: 'clerk_someone' });
    const found = await resolveCanonicalUser(repo, TENANT, 'clerk_nobody');
    expect(found).toBeNull();
  });

  it('does NOT filter by role — any tenant user matches, technician or not', async () => {
    const owner = await seedUser(repo, { clerkUserId: 'clerk_owner', role: 'owner' });
    const found = await resolveCanonicalUser(repo, TENANT, 'clerk_owner');
    expect(found?.id).toBe(owner.id);
    expect(found?.role).toBe('owner');
  });

  it('is tenant-scoped — a matching clerkUserId in a different tenant never resolves', async () => {
    await seedUser(repo, { tenantId: 'tenant-other', clerkUserId: 'clerk_cross_tenant' });
    const found = await resolveCanonicalUser(repo, TENANT, 'clerk_cross_tenant');
    expect(found).toBeNull();
  });
});
