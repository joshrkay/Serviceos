/**
 * #1090 — the shutdown drain for in-flight sweeps.
 *
 * Covers the three properties app.ts's shutdown path depends on: the registry
 * is transparent to callers, it actually waits for a running sweep before the
 * pool closes, and it gives up on a wedged one instead of holding the process
 * past index.ts's force-exit backstop.
 */
import { describe, expect, it } from 'vitest';
import { createInflightSweeps } from '../../src/workers/inflight-sweeps';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('createInflightSweeps', () => {
  it('returns the caller’s promise untouched, resolution and rejection alike', async () => {
    const sweeps = createInflightSweeps();

    await expect(sweeps.track(Promise.resolve('ok'))).resolves.toBe('ok');
    await expect(sweeps.track(Promise.reject(new Error('boom')))).rejects.toThrow('boom');
  });

  it('drops a sweep from the registry once it settles', async () => {
    const sweeps = createInflightSweeps();
    let release!: () => void;
    const work = new Promise<void>((resolve) => {
      release = resolve;
    });

    void sweeps.track(work);
    expect(sweeps.size()).toBe(1);

    release();
    await work;
    // The bookkeeping runs in a .finally continuation — let it flush.
    await sleep(0);
    expect(sweeps.size()).toBe(0);
  });

  it('does not mint an unhandled rejection when a tracked sweep rejects unobserved', async () => {
    const sweeps = createInflightSweeps();
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', onRejection);
    try {
      // The app.ts call site attaches its own .catch, but the registry must
      // be safe on its own — an unhandled rejection here would be logged as a
      // WARN by index.ts on every failing sweep.
      const work = Promise.reject(new Error('sweep failed'));
      sweeps.track(work).catch(() => undefined);
      await sleep(10);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
    expect(rejections).toEqual([]);
  });

  it('waits for a sweep that is still running, then reports it drained', async () => {
    const sweeps = createInflightSweeps();
    let finished = false;
    void sweeps.track(
      (async () => {
        await sleep(40);
        finished = true;
      })(),
    );

    const result = await sweeps.drain(1000);

    expect(finished).toBe(true);
    expect(result).toEqual({ drained: true, remaining: 0 });
  });

  it('waits for a sweep registered while the drain is already running', async () => {
    const sweeps = createInflightSweeps();
    let secondFinished = false;
    void sweeps.track(
      (async () => {
        await sleep(20);
        // A tick that started just before the intervals were cleared can
        // register more work as the drain begins.
        void sweeps.track(
          (async () => {
            await sleep(20);
            secondFinished = true;
          })(),
        );
      })(),
    );

    const result = await sweeps.drain(1000);

    expect(secondFinished).toBe(true);
    expect(result).toEqual({ drained: true, remaining: 0 });
  });

  it('gives up at the deadline instead of holding shutdown open', async () => {
    const sweeps = createInflightSweeps();
    let settle!: () => void;
    void sweeps.track(
      new Promise<void>((resolve) => {
        settle = resolve;
      }),
    );

    const started = Date.now();
    const result = await sweeps.drain(50);
    const elapsed = Date.now() - started;

    expect(result).toEqual({ drained: false, remaining: 1 });
    expect(elapsed).toBeLessThan(1000);

    settle();
  });

  it('is a no-op when nothing is in flight', async () => {
    const sweeps = createInflightSweeps();
    await expect(sweeps.drain(1000)).resolves.toEqual({ drained: true, remaining: 0 });
  });
});
