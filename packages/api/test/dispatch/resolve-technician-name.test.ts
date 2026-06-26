import { describe, it, expect } from 'vitest';
import { resolveTechnicianName } from '../../src/dispatch/routes';
import { User, UserRepository } from '../../src/users/user';

const TENANT = '11111111-1111-1111-1111-111111111111';
const TECH = '22222222-2222-2222-2222-222222222222';

function repoReturning(user: User | null): UserRepository {
  return {
    findById: async (tenantId: string, id: string) => {
      expect(tenantId).toBe(TENANT);
      expect(id).toBe(TECH);
      return user;
    },
  } as unknown as UserRepository;
}

function makeUser(overrides: Partial<User>): User {
  return {
    id: TECH,
    tenantId: TENANT,
    email: 'tech@example.com',
    role: 'technician',
    canFieldServe: true,
    ...overrides,
  } as User;
}

describe('resolveTechnicianName — board name resolution (U1)', () => {
  it('prefers "First Last" when both names are present', async () => {
    const repo = repoReturning(makeUser({ firstName: 'Dana', lastName: 'Reyes' }));
    expect(await resolveTechnicianName(repo, TENANT, TECH)).toBe('Dana Reyes');
  });

  it('uses a single present name without stray whitespace', async () => {
    const repo = repoReturning(makeUser({ firstName: 'Dana', lastName: undefined }));
    expect(await resolveTechnicianName(repo, TENANT, TECH)).toBe('Dana');
  });

  it('falls back to email when no name is on file', async () => {
    const repo = repoReturning(makeUser({ firstName: undefined, lastName: undefined, email: 'd@co.com' }));
    expect(await resolveTechnicianName(repo, TENANT, TECH)).toBe('d@co.com');
  });

  it('falls back to the raw id when the user row is missing (deactivated tech)', async () => {
    const repo = repoReturning(null);
    expect(await resolveTechnicianName(repo, TENANT, TECH)).toBe(TECH);
  });
});
