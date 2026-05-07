import { Job } from '../jobs/job';

export interface Contract {
  id: string;
  tenantId: string;
  customerId: string;
  locationId: string;
  defaultSummary: string;
  active: boolean;
}

export interface ContractRepository {
  listTenants(): Promise<string[]>;
  findActiveByTenant(tenantId: string): Promise<Contract[]>;
}

export interface GeneratedJobRecord {
  contractId: string;
  occurrenceDate: string;
}

export interface GeneratedJobsRepository {
  hasGenerated(record: GeneratedJobRecord): Promise<boolean>;
  markGenerated(record: GeneratedJobRecord): Promise<void>;
}

export type NextOccurrencesFn = (contract: Contract, windowDays: number, today: Date) => Date[];

export type ContractGeneratedJob = Job & {
  scheduledDate: Date;
  scheduledDateIso: string;
};

export interface ContractJobRepository {
  create(job: ContractGeneratedJob): Promise<Job>;
  getNextJobNumber(tenantId: string): Promise<number>;
}

export interface RunContractJobGenerationInput {
  contractRepo: ContractRepository;
  jobRepo: ContractJobRepository;
  nextOccurrences: NextOccurrencesFn;
  generatedJobsRepo?: GeneratedJobsRepository;
  today?: Date;
  windowDays?: number;
  createdBy?: string;
}

export interface ContractJobGenerationResult {
  created: number;
  skipped: number;
}

function occurrenceKey(contractId: string, occurrenceDate: Date): string {
  return `${contractId}:${occurrenceDate.toISOString().slice(0, 10)}`;
}

export async function runContractJobGeneration({
  contractRepo,
  jobRepo,
  nextOccurrences,
  generatedJobsRepo,
  today = new Date(),
  windowDays = 14,
  createdBy = 'system:contract-job-generator',
}: RunContractJobGenerationInput): Promise<ContractJobGenerationResult> {
  const tenants = await contractRepo.listTenants();
  const inRunGenerated = new Set<string>();

  let created = 0;
  let skipped = 0;

  for (const tenantId of tenants) {
    const activeContracts = (await contractRepo.findActiveByTenant(tenantId)).filter(
      (contract) => contract.active
    );

    for (const contract of activeContracts) {
      const occurrences = nextOccurrences(contract, windowDays, today);

      for (const occurrenceDate of occurrences) {
        const key = occurrenceKey(contract.id, occurrenceDate);
        if (inRunGenerated.has(key)) {
          skipped += 1;
          continue;
        }

        if (
          generatedJobsRepo &&
          (await generatedJobsRepo.hasGenerated({
            contractId: contract.id,
            occurrenceDate: occurrenceDate.toISOString().slice(0, 10),
          }))
        ) {
          skipped += 1;
          continue;
        }

        const nextJobNumber = await jobRepo.getNextJobNumber(contract.tenantId);
        const now = new Date();

        const jobPayload: ContractGeneratedJob = {
          id: crypto.randomUUID(),
          tenantId: contract.tenantId,
          customerId: contract.customerId,
          locationId: contract.locationId,
          jobNumber: `JOB-${String(nextJobNumber).padStart(4, '0')}`,
          summary: contract.defaultSummary,
          status: 'new',
          priority: 'normal',
          createdBy,
          createdAt: now,
          updatedAt: now,
          scheduledDate: occurrenceDate,
          scheduledDateIso: occurrenceDate.toISOString(),
        };

        await jobRepo.create(jobPayload);

        inRunGenerated.add(key);
        if (generatedJobsRepo) {
          await generatedJobsRepo.markGenerated({
            contractId: contract.id,
            occurrenceDate: occurrenceDate.toISOString().slice(0, 10),
          });
        }
        created += 1;
      }
    }
  }

  return { created, skipped };
}
