/**
 * #1125 / #1112 review — the in-flight sweep drain must OVERLAP the voice
 * drain, not queue behind it.
 *
 * `runShutdown` lives inside index.ts's single SHUTDOWN_FORCE_EXIT_MS backstop
 * (30s default). The voice drain alone may wait DRAIN_TIMEOUT_MS (25s default)
 * for live calls. When the sweep drain (SWEEP_DRAIN_TIMEOUT_MS, 5s) only
 * STARTED after that wait, a live voice session running to its deadline left
 * the sweep drain — and `pool.end()` after it — to be force-exited mid-flight:
 * the very outcome the sweep drain exists to prevent (a recovery SMS sent but
 * never stamped `sent`, re-sent on the next boot).
 *
 * Behavioral, not source-level: the real `createApp()` shutdown sequence runs
 * (in-memory mode), with the sweep registry replaced by a recorder so the test
 * sees WHEN its drain starts relative to the voice drain finishing. The voice
 * drain's end is observed through its own "drain complete" log line, which
 * runShutdown prints the moment its wait loop exits.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const events = vi.hoisted(() => [] as string[]);

vi.mock('../../src/workers/inflight-sweeps', () => ({
  createInflightSweeps: () => ({
    track: <T>(work: Promise<T>): Promise<T> => work,
    size: () => 0,
    drain: async () => {
      events.push('sweep drain started');
      // A sweep still mid-flight: settles on a later turn, so whether shutdown
      // actually waits for it is observable.
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 20);
      });
      events.push('sweep drain settled');
      return { drained: true, remaining: 0 };
    },
  }),
}));

import { createApp } from '../../src/app';

describe('#1125 — runShutdown overlaps the sweep drain with the voice drain', () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;

  beforeEach(() => {
    events.length = 0;
    delete process.env.DATABASE_URL;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  });

  it('starts draining in-flight sweeps before the voice drain wait ends, and still awaits it before teardown finishes', async () => {
    const realLog = console.log;
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      if (typeof args[0] === 'string' && args[0].includes('drain complete')) {
        events.push('voice drain complete');
      }
      realLog(...args);
    });

    const app = createApp();
    await app.gracefulDrain('test');
    events.push('shutdown resolved');

    expect(events).toContain('sweep drain started');
    expect(events).toContain('voice drain complete');
    // Overlap: the sweep drain is already running when the voice drain wait ends…
    expect(events.indexOf('sweep drain started')).toBeLessThan(events.indexOf('voice drain complete'));
    // …and shutdown still waits for it before it finishes (pool.end() follows it).
    expect(events.indexOf('sweep drain settled')).toBeLessThan(events.indexOf('shutdown resolved'));
  });
});
