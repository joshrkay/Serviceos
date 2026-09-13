/**
 * Characterization — background interval registration counts.
 *
 * PREREQUISITE SAFETY NET for the app.ts wiring decomposition (D-022).
 * This test pins numbers, not behaviour, and it is expected to be BORING:
 * it should pass unmodified against today's app.ts and keep passing after
 * repository/service construction moves out of createApp().
 *
 * Why it exists — `test/app/process-role.test.ts` already asserts the
 * PROCESS_ROLE split, but it asserts `toBeGreaterThan(0)` for the worker
 * roles. That leaves two ways for a wiring refactor to change behaviour
 * silently:
 *
 *   1. An interval moving between the GATED set (26 registrations behind
 *      `shouldRunWorkers`, app.ts:2535) and the UNGATED set (2 cheap
 *      observability intervals — samplePoolMetrics at app.ts:2554 and
 *      sampleQueueDepth at app.ts:2665). `backgroundIntervalCount` is
 *      computed at app.ts:7478 as
 *        `backgroundIntervals.length - observabilityIntervalCount`
 *      where `observabilityIntervalCount` (app.ts:2674) is a snapshot of
 *      `backgroundIntervals.length` taken PART-WAY THROUGH construction.
 *      It is therefore derived from registration ORDER: moving a gated
 *      registration above line 2674, or an ungated one below it, changes
 *      the reported count with no type error and no failing assertion.
 *
 *   2. A registration being dropped entirely by a factory extraction.
 *
 * Pinning the exact counts converts both into a one-line diff on this file,
 * which a reviewer must then justify.
 *
 * If you are here because this test failed: that is the test working. Either
 * you added/removed a background sweep (update the constant below in the same
 * commit, and say so in the PR), or a wiring change reordered registration
 * relative to app.ts:2674 (that is a behaviour change — do not update the
 * constant, fix the ordering).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createApp, type AppWithLifecycle } from '../../src/app';
import { resetConfig } from '../../src/shared/config';

/**
 * Gated worker intervals registered by a worker-role boot IN HERMETIC MODE
 * (no DATABASE_URL, no provider secrets), as of the characterization
 * baseline. Excludes the two ungated observability intervals by
 * construction (see `backgroundIntervalCount`, app.ts:7478).
 *
 * This is deliberately NOT the production number. app.ts has 26 `shouldRunWorkers`
 * registration sites, but several carry an ADDITIONAL condition and so do not
 * register in a hermetic boot — `pool && shouldRunWorkers` (app.ts:6137, 6287),
 * `oneTapSmsSender &&` (6550), `qboConfig &&` (6658), `transactionalComms &&`
 * (6682), `sendService &&` (6778), `config.AI_PROVIDER_API_KEY &&` (7287).
 * A configured deploy therefore registers MORE than this.
 *
 * The number is pinned anyway because the refactor being guarded does not
 * change configuration — it moves construction. Any movement in this figure
 * under identical env is a real behaviour change.
 */
const EXPECTED_WORKER_INTERVALS_HERMETIC = 21;

describe('characterization — background interval registration', () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalProcessRole = process.env.PROCESS_ROLE;
  const created: AppWithLifecycle[] = [];

  const buildApp = (role: string | undefined): AppWithLifecycle => {
    if (role === undefined) {
      delete process.env.PROCESS_ROLE;
    } else {
      process.env.PROCESS_ROLE = role;
    }
    // Config is cached; reset so each build re-reads PROCESS_ROLE.
    resetConfig();
    const app = createApp();
    created.push(app);
    return app;
  };

  beforeEach(() => {
    // In-memory mode: no pool/Redis, so the drain resolves without a backend.
    delete process.env.DATABASE_URL;
  });

  afterEach(async () => {
    for (const app of created.splice(0)) {
      await app.gracefulDrain('test-cleanup');
    }
    resetConfig();
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
    if (originalProcessRole === undefined) delete process.env.PROCESS_ROLE;
    else process.env.PROCESS_ROLE = originalProcessRole;
  });

  it('a worker-role boot registers an EXACT number of gated intervals', () => {
    const app = buildApp('worker');
    expect(app.backgroundIntervalCount).toBe(EXPECTED_WORKER_INTERVALS_HERMETIC);
  });

  it('"all" registers exactly the same gated intervals as "worker"', () => {
    const worker = buildApp('worker');
    const all = buildApp('all');
    expect(all.backgroundIntervalCount).toBe(worker.backgroundIntervalCount);
    expect(all.backgroundIntervalCount).toBe(EXPECTED_WORKER_INTERVALS_HERMETIC);
  });

  it('non-worker roles register exactly zero gated intervals', () => {
    // Pinned per-role rather than in a loop so a regression names the role.
    expect(buildApp('web').backgroundIntervalCount).toBe(0);
    expect(buildApp('voice').backgroundIntervalCount).toBe(0);
  });

  it('the count is stable across repeated boots in one process', () => {
    // Guards the decomposition against order-dependent construction: if a
    // factory extraction introduced module-level memoization, the second
    // boot would register a different number of intervals than the first.
    const first = buildApp('all');
    const second = buildApp('all');
    expect(second.backgroundIntervalCount).toBe(first.backgroundIntervalCount);
  });
});
