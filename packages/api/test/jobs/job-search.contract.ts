/**
 * #1406 D4 / #1416 — the jobs list search box promises "customer, address,
 * job #". ONE behavioural contract for `JobRepository.listWithMeta({ search })`,
 * run against BOTH implementations so they cannot drift apart again:
 *   - in-memory: test/jobs/job-search.in-memory.test.ts
 *   - Postgres:  test/integration/jobs-search.test.ts (Docker-gated)
 *
 * The world is seeded ONLY through the repositories' own `create` methods,
 * and observed only through `listWithMeta` — the public seam the jobs route
 * calls.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import crypto from 'node:crypto';
import type { JobRepository, Job } from '../../src/jobs/job';
import type { CustomerRepository } from '../../src/customers/customer';
import type { LocationRepository } from '../../src/locations/location';

export interface JobSearchWorld {
  jobRepo: JobRepository;
  customerRepo: Pick<CustomerRepository, 'create'>;
  locationRepo: Pick<LocationRepository, 'create'>;
  tenant: { tenantId: string; userId: string };
  otherTenant: { tenantId: string; userId: string };
}

export function describeJobSearchContract(
  label: string,
  makeWorld: () => Promise<JobSearchWorld>,
): void {
  describe(`${label} — jobs search contract (#1406 D4 / #1416)`, () => {
    let world: JobSearchWorld;
    let ramanJob: string;
    let hardyJob: string;
    let acmeJob: string;

    async function seedJob(
      t: { tenantId: string; userId: string },
      customer: { name: string; companyName?: string },
      location: { street1: string; city: string; postalCode: string },
      summary: string,
      jobNumber: string,
    ): Promise<string> {
      const customerId = crypto.randomUUID();
      const [firstName, lastName] = customer.name.split(' ');
      await world.customerRepo.create({
        id: customerId,
        tenantId: t.tenantId,
        firstName,
        lastName,
        displayName: customer.name,
        ...(customer.companyName ? { companyName: customer.companyName } : {}),
        preferredChannel: 'phone',
        smsConsent: false,
        isArchived: false,
        createdBy: t.userId,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const locationId = crypto.randomUUID();
      await world.locationRepo.create({
        id: locationId,
        tenantId: t.tenantId,
        customerId,
        street1: location.street1,
        city: location.city,
        state: 'AZ',
        postalCode: location.postalCode,
        country: 'USA',
        isPrimary: true,
        addressType: 'service',
        isArchived: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const id = crypto.randomUUID();
      await world.jobRepo.create({
        id,
        tenantId: t.tenantId,
        customerId,
        locationId,
        jobNumber,
        summary,
        status: 'new',
        priority: 'normal',
        createdBy: t.userId,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as Job);
      return id;
    }

    async function search(term: string): Promise<string[]> {
      const result = await world.jobRepo.listWithMeta!(world.tenant.tenantId, { search: term });
      expect(result.total).toBe(result.data.length);
      return result.data.map((j) => j.id).sort();
    }

    beforeAll(async () => {
      world = await makeWorld();
      const suffix = crypto.randomUUID().slice(0, 6);
      ramanJob = await seedJob(
        world.tenant,
        { name: 'Priya Raman' },
        { street1: '910 Ocotillo Dr', city: 'Mesa', postalCode: '85201' },
        'AC tune-up',
        `JOB-R${suffix}`,
      );
      hardyJob = await seedJob(
        world.tenant,
        { name: 'Glen Hardy' },
        { street1: '12 Mesquite Ct', city: 'Tempe', postalCode: '85281' },
        'Water heater flush',
        `JOB-H${suffix}`,
      );
      acmeJob = await seedJob(
        world.tenant,
        { name: 'Dana Ortiz', companyName: 'Saguaro Property Group' },
        { street1: '4 Palo Verde Ln', city: 'Chandler', postalCode: '85224' },
        'Rooftop unit inspection',
        `JOB-A${suffix}`,
      );
      // Same customer name + street in ANOTHER tenant: never a result.
      await seedJob(
        world.otherTenant,
        { name: 'Priya Raman' },
        { street1: '910 Ocotillo Dr', city: 'Mesa', postalCode: '85201' },
        'Other tenant job',
        `JOB-X${suffix}`,
      );
    });

    it('matches the job summary (case-insensitive)', async () => {
      expect(await search('water HEATER')).toEqual([hardyJob]);
    });

    it("matches the job's customer display name", async () => {
      expect(await search('raman')).toEqual([ramanJob]);
    });

    it("matches the job's customer company name", async () => {
      expect(await search('saguaro')).toEqual([acmeJob]);
    });

    it("matches the job's service street, city and postal code", async () => {
      expect(await search('Ocotillo')).toEqual([ramanJob]);
      expect(await search('tempe')).toEqual([hardyJob]);
      expect(await search('85224')).toEqual([acmeJob]);
    });

    it('a term matching nothing returns no jobs', async () => {
      expect(await search('zzz-no-such-job')).toEqual([]);
    });
  });
}
