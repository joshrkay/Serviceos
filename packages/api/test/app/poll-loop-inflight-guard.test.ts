/**
 * RV-006 — Poll-loop in-flight guard unit test.
 *
 * The unified worker poll loop in app.ts uses a `pollInFlight` boolean to
 * ensure at most one async tick body runs at a time. This test exercises
 * the guard pattern in isolation (no app boot, no DB, no queue) by
 * replicating the exact structure and verifying:
 *
 *   1. Concurrent ticks are skipped while a previous one is running.
 *   2. The flag is released via finally even when the body throws.
 *   3. A new tick can proceed after the flag is released.
 */
import { describe, it, expect } from 'vitest';

/**
 * A minimal replica of the poll-loop body as a named helper so the guard
 * logic can be unit-tested without booting the full app.
 *
 * Returns the number of times `work` was actually invoked (i.e. not skipped
 * by the guard) across all `ticks` simulated calls.
 */
async function runPollLoopSimulation(opts: {
  ticks: (() => Promise<void>)[];
  /** If true, the guard flag is held for the duration of each tick body. */
  applyGuard: boolean;
}): Promise<{ invocations: number }> {
  let inFlight = false;
  let invocations = 0;

  const results = opts.ticks.map(async (tick) => {
    if (opts.applyGuard && inFlight) return; // guard: skip overlapping tick
    if (opts.applyGuard) inFlight = true;
    try {
      invocations++;
      await tick();
    } finally {
      if (opts.applyGuard) inFlight = false;
    }
  });

  await Promise.all(results);
  return { invocations };
}

describe('poll-loop in-flight guard', () => {
  it('without guard: all concurrent ticks execute (baseline)', async () => {
    let running = 0;
    let maxConcurrent = 0;

    const slowTick = async () => {
      running++;
      maxConcurrent = Math.max(maxConcurrent, running);
      await new Promise<void>((r) => setTimeout(r, 5));
      running--;
    };

    const { invocations } = await runPollLoopSimulation({
      ticks: [slowTick, slowTick, slowTick],
      applyGuard: false,
    });

    expect(invocations).toBe(3);
    expect(maxConcurrent).toBeGreaterThan(1); // confirms concurrency without guard
  });

  it('with guard: overlapping ticks are skipped, only the first runs', async () => {
    let running = 0;
    let maxConcurrent = 0;

    const slowTick = async () => {
      running++;
      maxConcurrent = Math.max(maxConcurrent, running);
      await new Promise<void>((r) => setTimeout(r, 5));
      running--;
    };

    const { invocations } = await runPollLoopSimulation({
      ticks: [slowTick, slowTick, slowTick],
      applyGuard: true,
    });

    expect(invocations).toBe(1); // only first tick ran; others were skipped
    expect(maxConcurrent).toBe(1); // never more than one concurrent body
  });

  it('with guard: flag is released via finally even when the body throws', async () => {
    let callCount = 0;
    const throwingTick = async () => {
      callCount++;
      throw new Error('simulated poll failure');
    };

    // First tick throws — but flag must be released so subsequent ticks run.
    let inFlight = false;
    let invocations = 0;

    const runOneTick = async (tick: () => Promise<void>) => {
      if (inFlight) return;
      inFlight = true;
      try {
        invocations++;
        await tick();
      } catch {
        // swallowed (mirrors app.ts catch block)
      } finally {
        inFlight = false;
      }
    };

    await runOneTick(throwingTick); // throws internally, flag must be reset
    expect(inFlight).toBe(false); // flag released despite throw

    await runOneTick(throwingTick); // second tick must NOT be skipped
    expect(callCount).toBe(2); // both calls made it past the guard
    expect(invocations).toBe(2);
  });

  it('with guard: sequential (non-overlapping) ticks all execute', async () => {
    const results: number[] = [];
    const ticks = [1, 2, 3].map((n) => async () => {
      results.push(n);
    });

    // Run sequentially — each tick completes before the next fires.
    for (const tick of ticks) {
      await runPollLoopSimulation({ ticks: [tick], applyGuard: true });
    }

    expect(results).toEqual([1, 2, 3]);
  });
});
