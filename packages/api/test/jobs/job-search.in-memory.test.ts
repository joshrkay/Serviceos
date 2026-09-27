/**
 * #1416 — the in-memory job repository searched only summary + job number,
 * while Postgres (#1406 D4) also matches the customer's name and the service
 * address. Runs the shared contract (job-search.contract.ts) against the
 * in-memory repositories, wired the way build-repositories wires them.
 */
import { describeJobSearchContract } from './job-search.contract';
import { InMemoryJobRepository } from '../../src/jobs/job';
import { InMemoryCustomerRepository } from '../../src/customers/customer';
import { InMemoryLocationRepository } from '../../src/locations/location';
import { buildRepositories } from '../../src/db/build-repositories';

describeJobSearchContract('InMemoryJobRepository', async () => {
  const customerRepo = new InMemoryCustomerRepository();
  const locationRepo = new InMemoryLocationRepository();
  return {
    jobRepo: new InMemoryJobRepository({
      customers: () => customerRepo,
      locations: () => locationRepo,
    }),
    customerRepo,
    locationRepo,
    tenant: { tenantId: 'tenant-search-a', userId: 'user-a' },
    otherTenant: { tenantId: 'tenant-search-b', userId: 'user-b' },
  };
});

// The hermetic app wiring (no DATABASE_URL): the job repo must see the SAME
// customer/location repos the rest of the app writes to.
describeJobSearchContract('buildRepositories (no pool)', async () => {
  const repos = buildRepositories(undefined, undefined);
  return {
    jobRepo: repos.jobRepo,
    customerRepo: repos.customerRepo,
    locationRepo: repos.locationRepo,
    tenant: { tenantId: 'tenant-search-a', userId: 'user-a' },
    otherTenant: { tenantId: 'tenant-search-b', userId: 'user-b' },
  };
});
