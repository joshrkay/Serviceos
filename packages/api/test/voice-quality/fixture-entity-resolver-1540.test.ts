/**
 * #1540 §1 (owner decision 2026-10-01) — ONE fixture-backed entity resolver
 * (inapp-50's `FixtureEntityResolver`, generalised) that also runs over the
 * voice-quality runner's `RepoBundle`, so the Layer 2 harness can wire an
 * entity resolver the way app.ts wires `PgEntityResolver`. Appointment
 * references then resolve against the seeded rows ("my appointment on
 * Tuesday", "the customer on the 10am") instead of staying free text.
 *
 * Seam: `FixtureEntityResolver.resolve` over a `makeRepoBundle` bundle seeded
 * through the repositories' own `create`.
 */
import { describe, it, expect } from 'vitest';
import { makeRepoBundle, type RepoBundle } from '../../src/ai/voice-quality/runner';
import { FixtureEntityResolver } from '../../src/ai/voice-quality/fixture-entity-resolver';
import type { Customer } from '../../src/customers/customer';
import type { Job } from '../../src/jobs/job';
import type { Appointment } from '../../src/appointments/appointment';

const TENANT = 't-1540-resolver';
const LA = 'America/Los_Angeles';
/** The voice-quality corpus world: Friday 2026-05-01, 05:00 in Los Angeles. */
const CORPUS_NOW = () => new Date('2026-05-01T12:00:00.000Z');

const JANE = '00000000-0000-4000-8000-000015400001';
const JANE_JOB = '00000000-0000-4000-8000-000015400002';
const JANE_TUESDAY = '00000000-0000-4000-8000-000015400003';
const BOB = '00000000-0000-4000-8000-000015400004';
const BOB_JOB = '00000000-0000-4000-8000-000015400005';
const BOB_TEN_AM = '00000000-0000-4000-8000-000015400006';

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
    locationId: '00000000-0000-4000-8000-0000154000ff',
    jobNumber: `JOB-${id.slice(-4)}`,
    summary,
    status: 'scheduled',
    priority: 'normal',
    createdBy: 'seed',
    createdAt: new Date('2026-04-15T10:00:00.000Z'),
    updatedAt: new Date('2026-04-15T10:00:00.000Z'),
  } as unknown as Job;
}

function appointment(id: string, jobId: string, startIso: string, endIso: string): Appointment {
  return {
    id,
    tenantId: TENANT,
    jobId,
    scheduledStart: new Date(startIso),
    scheduledEnd: new Date(endIso),
    timezone: LA,
    status: 'scheduled',
    createdBy: 'seed',
    createdAt: new Date('2026-04-15T10:00:00.000Z'),
    updatedAt: new Date('2026-04-15T10:00:00.000Z'),
  } as unknown as Appointment;
}

async function seededBundle(): Promise<RepoBundle> {
  const repos = makeRepoBundle('memory');
  await repos.customerRepo.create(customer(JANE, 'Jane', 'Smith'));
  await repos.customerRepo.create(customer(BOB, 'Bob', 'Jones'));
  await repos.jobRepo.create(job(JANE_JOB, JANE, 'AC service'));
  await repos.jobRepo.create(job(BOB_JOB, BOB, 'Furnace tune-up'));
  // Jane: Tuesday May 5, 2pm PDT. Bob: today (Fri May 1), 10am PDT.
  await repos.appointmentRepo.create(
    appointment(JANE_TUESDAY, JANE_JOB, '2026-05-05T21:00:00.000Z', '2026-05-05T23:00:00.000Z'),
  );
  await repos.appointmentRepo.create(
    appointment(BOB_TEN_AM, BOB_JOB, '2026-05-01T17:00:00.000Z', '2026-05-01T18:00:00.000Z'),
  );
  return repos;
}

describe('#1540 §1 — FixtureEntityResolver over the runner RepoBundle', () => {
  it("resolves the caller's \"appointment on Tuesday\" to their seeded Tuesday visit", async () => {
    const repos = await seededBundle();
    const resolver = new FixtureEntityResolver(() => ({
      tenantId: TENANT,
      timezone: LA,
      now: CORPUS_NOW,
      ...repos,
    }));

    const result = await resolver.resolve({
      tenantId: TENANT,
      reference: 'my appointment on Tuesday',
      kind: 'appointment',
      customerId: JANE,
    });

    expect(result.kind).toBe('resolved');
    expect(result.kind === 'resolved' && result.candidate.id).toBe(JANE_TUESDAY);
  });

  it('resolves a TIME-OF-DAY reference ("the customer on the 10am") like PgEntityResolver: the visit at that clock time', async () => {
    const repos = await seededBundle();
    const resolver = new FixtureEntityResolver(() => ({
      tenantId: TENANT,
      timezone: LA,
      now: CORPUS_NOW,
      ...repos,
    }));

    const result = await resolver.resolve({
      tenantId: TENANT,
      reference: 'the customer on the 10am',
      kind: 'appointment',
    });

    expect(result.kind === 'resolved' && result.candidate.id).toBe(BOB_TEN_AM);
  });

  it('a stated clock time with nothing at it is an honest not_found — never another visit', async () => {
    const repos = await seededBundle();
    const resolver = new FixtureEntityResolver(() => ({
      tenantId: TENANT,
      timezone: LA,
      now: CORPUS_NOW,
      ...repos,
    }));

    const result = await resolver.resolve({
      tenantId: TENANT,
      reference: 'the 4pm',
      kind: 'appointment',
    });

    expect(result.kind).toBe('not_found');
  });
});
