import { faker } from '@faker-js/faker';
import { ServiceLocation, CreateLocationInput } from '../../src/locations/location';

export function buildLocation(overrides?: Partial<ServiceLocation>): ServiceLocation {
  return {
    id: faker.string.uuid(),
    tenantId: faker.string.uuid(),
    customerId: faker.string.uuid(),
    label: faker.location.secondaryAddress(),
    street1: faker.location.streetAddress(),
    street2: faker.location.secondaryAddress(),
    city: faker.location.city(),
    state: faker.location.state({ abbreviated: true }),
    postalCode: faker.location.zipCode(),
    country: 'US',
    latitude: faker.location.latitude(),
    longitude: faker.location.longitude(),
    accessNotes: faker.lorem.sentence(),
    isPrimary: true,
    isArchived: false,
    createdAt: faker.date.recent(),
    updatedAt: faker.date.recent(),
    ...overrides,
  };
}

export function buildCreateLocationInput(overrides?: Partial<CreateLocationInput>): CreateLocationInput {
  return {
    tenantId: faker.string.uuid(),
    customerId: faker.string.uuid(),
    street1: faker.location.streetAddress(),
    city: faker.location.city(),
    state: faker.location.state({ abbreviated: true }),
    postalCode: faker.location.zipCode(),
    ...overrides,
  };
}
