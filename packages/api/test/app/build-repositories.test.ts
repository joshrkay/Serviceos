/**
 * buildRepositories() — adapter resolution.
 *
 * These cases replace the `pool ? Pg : InMemory` coverage that used to live in
 * test/app/wiring.test.ts as regex-over-source. That test read app.ts as a
 * string because repository construction was inline in a 6,715-line function
 * with no interface to test through — it passed on the presence of characters
 * and would fail on a reformat. Now that construction lives behind
 * buildRepositories() (D-024 Stage 1), the same invariant is asserted against
 * the RESOLVED implementation.
 *
 * The snapshot below is the forward guard for the remaining decomposition
 * stages: it is derived from the returned object, so it needs no
 * hand-maintained list and cannot silently disagree with the code.
 */
import { describe, it, expect } from 'vitest';
import type { Pool } from 'pg';
import { buildRepositories } from '../../src/db/build-repositories';
import { InMemoryCustomerRepository } from '../../src/customers/customer';
import { InMemoryAssignmentRepository } from '../../src/appointments/assignment';

// The repositories take the pool and hold it; none query during construction,
// so an opaque stub is enough to select the Postgres branch.
const stubPool = {} as Pool;

const resolutionMap = (pool: Pool | undefined) =>
  Object.fromEntries(
    Object.entries(buildRepositories(pool, pool)).map(([key, value]) => [
      key,
      (value as object).constructor.name,
    ]),
  );

describe('buildRepositories — adapter resolution', () => {
  // The seven entities P0-023 originally pinned, now asserted through the
  // interface rather than against app.ts source text.
  it.each([
    ['Assignment', 'assignmentRepo', 'PgAssignmentRepository', 'InMemoryAssignmentRepository'],
    ['WebhookEvent', 'webhookEventRepo', 'PgWebhookEventRepository', 'InMemoryWebhookEventRepository'],
    ['DocumentRevision', 'documentRevisionRepo', 'PgDocumentRevisionRepository', 'InMemoryDocumentRevisionRepository'],
    ['DiffAnalysis', 'diffAnalysisRepo', 'PgDiffAnalysisRepository', 'InMemoryDiffAnalysisRepository'],
    ['DispatchAnalytics', 'dispatchAnalyticsRepo', 'PgDispatchAnalyticsRepository', 'InMemoryDispatchAnalyticsRepository'],
    ['DelayNoticeState', 'delayNoticeStateRepo', 'PgDelayNoticeStateRepository', 'InMemoryDelayNoticeStateRepository'],
    ['TechStatusToday', 'techStatusTodayRepo', 'PgTechStatusTodayRepository', 'InMemoryTechStatusTodayRepository'],
  ])('%s resolves to Pg with a pool and InMemory without', (_label, key, pgClass, memClass) => {
    expect(resolutionMap(stubPool)[key]).toBe(pgClass);
    expect(resolutionMap(undefined)[key]).toBe(memClass);
  });

  it('every repository resolves to an InMemory implementation without a pool', () => {
    // Pins the hermetic guarantee the 18 booting test files depend on: no
    // DATABASE_URL must mean no Postgres adapter anywhere in the set.
    const pgLeaks = Object.entries(resolutionMap(undefined)).filter(([, impl]) =>
      impl.startsWith('Pg'),
    );
    expect(pgLeaks).toEqual([]);
  });

  it('the same set of repositories is returned in both modes', () => {
    expect(Object.keys(resolutionMap(stubPool))).toEqual(Object.keys(resolutionMap(undefined)));
  });

  it('resolution map is stable across calls', () => {
    expect(resolutionMap(undefined)).toEqual(resolutionMap(undefined));
  });

  // Forward guard for D-024 Stage 2+. Derived from the returned object, so a
  // new repository updates it by regenerating the snapshot — but a repository
  // silently switching adapter, or disappearing, fails first.
  it('resolution snapshot — no pool', () => {
    expect(resolutionMap(undefined)).toMatchSnapshot();
  });

  it('resolution snapshot — with pool', () => {
    expect(resolutionMap(stubPool)).toMatchSnapshot();
  });
});

/**
 * Sibling overrides.
 *
 * `customerMergeRepo` and `appointmentRepo` capture a sibling repository in
 * their in-memory CONSTRUCTOR. A spread applied to the returned set therefore
 * cannot reach inside them, so buildRepositories takes those two overrides
 * directly. Without that, `createApp({ customerRepo })` would substitute the
 * repo everywhere EXCEPT the one place that had already captured the default —
 * a silent split-brain that no type check would catch.
 */
describe('buildRepositories — sibling overrides reach dependent repositories', () => {
  it('customerMergeRepo delegates to an overridden customerRepo', async () => {
    const calls: string[] = [];
    const spyCustomerRepo = {
      ...new InMemoryCustomerRepository(),
      update: async (tenantId: string, id: string) => {
        calls.push(`${tenantId}/${id}`);
        return null;
      },
    } as unknown as InMemoryCustomerRepository;

    const { customerMergeRepo } = buildRepositories(undefined, undefined, {
      customerRepo: spyCustomerRepo,
    });
    await customerMergeRepo.reassignAndArchive('tenant-1', 'survivor', 'loser');

    expect(calls).toEqual(['tenant-1/loser']);
  });

  it('appointmentRepo receives an overridden assignmentRepo', () => {
    const lookup = { listByAppointmentIds: async () => new Map() };
    const { appointmentRepo } = buildRepositories(undefined, undefined, {
      assignmentRepo: lookup as unknown as InMemoryAssignmentRepository,
    });
    // The lookup is captured privately; assert the dependent was built with the
    // override rather than a default instance by identity through the closure.
    expect((appointmentRepo as unknown as { technicianAssignments?: unknown }).technicianAssignments)
      .toBe(lookup);
  });

  it('the overridden sibling is also returned in the set', () => {
    const spy = new InMemoryCustomerRepository();
    const { customerRepo } = buildRepositories(undefined, undefined, { customerRepo: spy });
    expect(customerRepo).toBe(spy);
  });
});
