/**
 * #1331 — the fixture resolver mirrors `PgEntityResolver.resolveJobForCustomer`:
 * a job reference with the customer ALREADY resolved is asked within that
 * customer's jobs. A reference naming only the customer is their one job, or
 * the which-job question when they have several. Without the anchor the
 * fixture resolver searched tenant-wide, so "Garcia" matched every Garcia's
 * job — a different answer from production's.
 *
 * Seam: `FixtureEntityResolver.resolve` over a `makeRepoBundle` bundle.
 */
import { describe, it, expect } from 'vitest';
import { makeRepoBundle, type RepoBundle } from '../../src/ai/voice-quality/runner';
import { FixtureEntityResolver } from '../../src/ai/voice-quality/fixture-entity-resolver';
import type { Customer } from '../../src/customers/customer';
import type { Job } from '../../src/jobs/job';

const TENANT = 't-1331-anchored-job';
const MARIA = '00000000-0000-4000-8000-000013311001';
const LUIS = '00000000-0000-4000-8000-000013311002';
const MARIA_JOB = '00000000-0000-4000-8000-000013311003';
const LUIS_JOB = '00000000-0000-4000-8000-000013311004';
const LUIS_JOB_2 = '00000000-0000-4000-8000-000013311005';

function customer(id: string, first: string, last: string): Customer {
  return {
    id,
    tenantId: TENANT,
    firstName: first,
    lastName: last,
    displayName: `${first} ${last}`,
    primaryPhone: '+15555550100',
    isArchived: false,
    createdBy: 'seed',
    createdAt: new Date('2026-01-15T10:00:00.000Z'),
    updatedAt: new Date('2026-01-15T10:00:00.000Z'),
  } as unknown as Customer;
}

function job(id: string, customerId: string, summary: string): Job {
  return {
    id,
    tenantId: TENANT,
    customerId,
    jobNumber: `JOB-${id.slice(-4)}`,
    summary,
    status: 'in_progress',
    priority: 'normal',
    createdBy: 'seed',
    createdAt: new Date('2026-04-15T10:00:00.000Z'),
    updatedAt: new Date('2026-04-15T10:00:00.000Z'),
  } as unknown as Job;
}

async function world(): Promise<FixtureEntityResolver> {
  const repos: RepoBundle = makeRepoBundle('memory');
  await repos.customerRepo.create(customer(MARIA, 'Maria', 'Garcia'));
  await repos.customerRepo.create(customer(LUIS, 'Luis', 'Garcia'));
  await repos.jobRepo.create(job(MARIA_JOB, MARIA, 'Ductless mini-split install'));
  await repos.jobRepo.create(job(LUIS_JOB, LUIS, 'Water heater replacement'));
  await repos.jobRepo.create(job(LUIS_JOB_2, LUIS, 'Furnace tune-up'));
  return new FixtureEntityResolver(() => ({ tenantId: TENANT, timezone: 'America/Los_Angeles', ...repos }));
}

describe('#1331 — FixtureEntityResolver: a job reference anchored on a resolved customer', () => {
  it("the customer's name alone is that customer's one job", async () => {
    const result = await (await world()).resolve({
      tenantId: TENANT,
      reference: 'Garcia',
      kind: 'job',
      customerId: MARIA,
    });

    expect(result.kind === 'resolved' && result.candidate.id).toBe(MARIA_JOB);
  });

  it('a customer with several jobs is the which-job question, never a pick', async () => {
    const result = await (await world()).resolve({
      tenantId: TENANT,
      reference: 'Garcia',
      kind: 'job',
      customerId: LUIS,
    });

    expect(result.kind).toBe('ambiguous');
    expect(result.kind === 'ambiguous' && result.candidates.map((c) => c.id).sort()).toEqual(
      [LUIS_JOB, LUIS_JOB_2].sort(),
    );
  });
});
