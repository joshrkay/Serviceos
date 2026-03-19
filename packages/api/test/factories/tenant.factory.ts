import { faker } from './faker';
import { TenantRow, UserRow } from '../../src/db/schema';

export function buildTenant(overrides?: Partial<TenantRow>): TenantRow {
  return {
    id: faker.string.uuid(),
    owner_id: faker.string.uuid(),
    owner_email: faker.internet.email(),
    name: faker.company.name(),
    created_at: faker.date.recent(),
    updated_at: faker.date.recent(),
    ...overrides,
  };
}

export function buildUser(overrides?: Partial<UserRow>): UserRow {
  return {
    id: faker.string.uuid(),
    tenantId: faker.string.uuid(),
    clerkUserId: `user_${faker.string.alphanumeric(24)}`,
    email: faker.internet.email(),
    role: faker.helpers.arrayElement(['owner', 'dispatcher', 'technician']),
    firstName: faker.person.firstName(),
    lastName: faker.person.lastName(),
    createdAt: faker.date.recent(),
    updatedAt: faker.date.recent(),
    ...overrides,
  };
}
