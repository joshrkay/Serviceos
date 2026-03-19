import { faker } from './faker';
import { Job, CreateJobInput, JobStatus, JobPriority } from '../../src/jobs/job';

export function buildJob(overrides?: Partial<Job>): Job {
  return {
    id: faker.string.uuid(),
    tenantId: faker.string.uuid(),
    customerId: faker.string.uuid(),
    locationId: faker.string.uuid(),
    jobNumber: `JOB-${faker.string.numeric(4)}`,
    summary: faker.lorem.sentence(),
    problemDescription: faker.lorem.paragraph(),
    status: 'new' as JobStatus,
    priority: 'normal' as JobPriority,
    assignedTechnicianId: undefined,
    createdBy: faker.string.uuid(),
    createdAt: faker.date.recent(),
    updatedAt: faker.date.recent(),
    ...overrides,
  };
}

export function buildCreateJobInput(overrides?: Partial<CreateJobInput>): CreateJobInput {
  return {
    tenantId: faker.string.uuid(),
    customerId: faker.string.uuid(),
    locationId: faker.string.uuid(),
    summary: faker.lorem.sentence(),
    problemDescription: faker.lorem.paragraph(),
    priority: 'normal',
    createdBy: faker.string.uuid(),
    ...overrides,
  };
}
