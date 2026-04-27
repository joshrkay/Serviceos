import { describe, expect, it, vi } from 'vitest';
import {
  Contract,
  ContractGeneratedJob,
  ContractRepository,
  ContractJobRepository,
  GeneratedJobRecord,
  GeneratedJobsRepository,
  runContractJobGeneration,
} from '../../src/contracts/contract-job-generator';

class InMemoryGeneratedJobsRepository implements GeneratedJobsRepository {
  private readonly keys = new Set<string>();

  async hasGenerated(record: GeneratedJobRecord): Promise<boolean> {
    return this.keys.has(`${record.contractId}:${record.occurrenceDate}`);
  }

  async markGenerated(record: GeneratedJobRecord): Promise<void> {
    this.keys.add(`${record.contractId}:${record.occurrenceDate}`);
  }
}

function makeContract(overrides?: Partial<Contract>): Contract {
  return {
    id: 'contract-1',
    tenantId: 'tenant-1',
    customerId: 'customer-1',
    locationId: 'location-1',
    defaultSummary: 'Quarterly maintenance',
    active: true,
    ...overrides,
  };
}

describe('contract-job-generator', () => {
  it('generates jobs for active contracts only', async () => {
    const active = makeContract({ id: 'contract-active' });
    const inactive = makeContract({ id: 'contract-inactive', active: false });

    const contractRepo: ContractRepository = {
      listTenants: vi.fn(async () => ['tenant-1']),
      findActiveByTenant: vi.fn(async () => [active, inactive]),
    };

    const createdJobs: ContractGeneratedJob[] = [];
    const jobRepo: ContractJobRepository = {
      create: vi.fn(async (job) => {
        createdJobs.push(job);
        return job;
      }),
      getNextJobNumber: vi.fn(async () => createdJobs.length + 1),
    };

    const nextOccurrences = vi.fn((contract: Contract) => {
      if (contract.id === inactive.id) {
        return [new Date('2026-05-01T00:00:00.000Z')];
      }
      return [new Date('2026-05-01T00:00:00.000Z')];
    });

    await runContractJobGeneration({
      contractRepo,
      jobRepo,
      nextOccurrences,
      today: new Date('2026-04-27T00:00:00.000Z'),
    });

    expect(nextOccurrences).toHaveBeenCalledTimes(1);
    expect(nextOccurrences).toHaveBeenCalledWith(active, 14, new Date('2026-04-27T00:00:00.000Z'));
    expect(createdJobs).toHaveLength(1);
    expect(createdJobs[0].summary).toBe(active.defaultSummary);
  });

  it('uses default summary/status/customer/location and scheduled date fields', async () => {
    const contract = makeContract({
      customerId: 'customer-9',
      locationId: 'location-9',
      defaultSummary: 'Bi-weekly filter replacement',
    });

    const contractRepo: ContractRepository = {
      listTenants: vi.fn(async () => ['tenant-1']),
      findActiveByTenant: vi.fn(async () => [contract]),
    };

    const createdJobs: ContractGeneratedJob[] = [];
    const jobRepo: ContractJobRepository = {
      create: vi.fn(async (job) => {
        createdJobs.push(job);
        return job;
      }),
      getNextJobNumber: vi.fn(async () => 1),
    };

    const date = new Date('2026-04-30T12:00:00.000Z');
    await runContractJobGeneration({
      contractRepo,
      jobRepo,
      nextOccurrences: vi.fn(() => [date]),
      today: new Date('2026-04-27T00:00:00.000Z'),
    });

    expect(createdJobs).toHaveLength(1);
    expect(createdJobs[0]).toMatchObject({
      summary: 'Bi-weekly filter replacement',
      status: 'new',
      customerId: 'customer-9',
      locationId: 'location-9',
      scheduledDateIso: '2026-04-30T12:00:00.000Z',
    });
    expect(createdJobs[0].scheduledDate).toEqual(date);
  });

  it('uses 14-day look-ahead by default', async () => {
    const contract = makeContract();
    const contractRepo: ContractRepository = {
      listTenants: vi.fn(async () => ['tenant-1']),
      findActiveByTenant: vi.fn(async () => [contract]),
    };

    const jobRepo: ContractJobRepository = {
      create: vi.fn(async (job) => job),
      getNextJobNumber: vi.fn(async () => 1),
    };

    const nextOccurrences = vi.fn(() => []);

    await runContractJobGeneration({
      contractRepo,
      jobRepo,
      nextOccurrences,
      today: new Date('2026-04-27T00:00:00.000Z'),
    });

    expect(nextOccurrences).toHaveBeenCalledWith(contract, 14, new Date('2026-04-27T00:00:00.000Z'));
  });

  it('is idempotent across runs for already generated contract occurrence dates', async () => {
    const contract = makeContract();
    const occurrence = new Date('2026-05-01T00:00:00.000Z');

    const contractRepo: ContractRepository = {
      listTenants: vi.fn(async () => ['tenant-1']),
      findActiveByTenant: vi.fn(async () => [contract]),
    };

    const createdJobs: ContractGeneratedJob[] = [];
    const jobRepo: ContractJobRepository = {
      create: vi.fn(async (job) => {
        createdJobs.push(job);
        return job;
      }),
      getNextJobNumber: vi.fn(async () => createdJobs.length + 1),
    };

    const generatedJobsRepo = new InMemoryGeneratedJobsRepository();
    const nextOccurrences = vi.fn(() => [occurrence]);

    const first = await runContractJobGeneration({
      contractRepo,
      jobRepo,
      nextOccurrences,
      generatedJobsRepo,
      today: new Date('2026-04-27T00:00:00.000Z'),
    });

    const second = await runContractJobGeneration({
      contractRepo,
      jobRepo,
      nextOccurrences,
      generatedJobsRepo,
      today: new Date('2026-04-27T00:00:00.000Z'),
    });

    expect(first).toEqual({ created: 1, skipped: 0 });
    expect(second).toEqual({ created: 0, skipped: 1 });
    expect(createdJobs).toHaveLength(1);
  });
});
