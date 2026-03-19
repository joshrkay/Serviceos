import { faker } from './faker';
import { Customer, CreateCustomerInput, PreferredChannel } from '../../src/customers/customer';

export function buildCustomer(overrides?: Partial<Customer>): Customer {
  return {
    id: faker.string.uuid(),
    tenantId: faker.string.uuid(),
    firstName: faker.person.firstName(),
    lastName: faker.person.lastName(),
    displayName: faker.person.fullName(),
    companyName: faker.company.name(),
    primaryPhone: faker.phone.number(),
    secondaryPhone: faker.phone.number(),
    email: faker.internet.email(),
    preferredChannel: 'phone' as PreferredChannel,
    smsConsent: false,
    communicationNotes: faker.lorem.sentence(),
    isArchived: false,
    createdBy: faker.string.uuid(),
    createdAt: faker.date.recent(),
    updatedAt: faker.date.recent(),
    ...overrides,
  };
}

export function buildCreateCustomerInput(overrides?: Partial<CreateCustomerInput>): CreateCustomerInput {
  return {
    tenantId: faker.string.uuid(),
    firstName: faker.person.firstName(),
    lastName: faker.person.lastName(),
    companyName: faker.company.name(),
    primaryPhone: faker.phone.number(),
    email: faker.internet.email(),
    preferredChannel: 'phone',
    createdBy: faker.string.uuid(),
    ...overrides,
  };
}
