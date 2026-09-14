/**
 * #1090 — a bounded "wait for in-flight sweeps" registry for shutdown.
 *
 * Shutdown clears every sweep interval and flips `shuttingDown`, which stops
 * the NEXT tick — but says nothing about the tick that is already running.
 * A sweep sitting in a compose/send round-trip at that moment keeps going,
 * and `pool.end()` a few lines later pulls the pool out from under it: its
 * next repository call throws `Cannot use a pool after calling end on the
 * pool`, once per remaining tenant/row. That is the tail of the #1090
 * incident log, and it is also a correctness problem — a recovery SMS can go
 * out to a customer and then fail to be stamped `sent`, so the next boot
 * re-sends it.
 *
 * So: register each leader-gated sweep run here, and drain (bounded) before
 * the pool closes. Bounded because shutdown must stay inside index.ts's
 * force-exit backstop — a sweep wedged on a hung upstream must not hold the
 * process open. `drain` therefore reports whether it finished or gave up, and
 * the caller proceeds either way.
 */
export interface InflightSweeps {
  /**
   * Register a running sweep. Returns the SAME promise (settled or rejected
   * exactly as the caller's), so this can wrap a call site without changing
   * its error handling.
   */
  track<T>(work: Promise<T>): Promise<T>;
  /** How many sweeps are running right now. */
  size(): number;
  /**
   * Wait for everything registered to settle, up to `timeoutMs`. Sweeps
   * registered WHILE draining are waited on too (a tick that started just
   * before the intervals were cleared), still inside the same deadline.
   */
  drain(timeoutMs: number): Promise<{ drained: boolean; remaining: number }>;
}

export function createInflightSweeps(): InflightSweeps {
  const running = new Set<Promise<unknown>>();

  return {
    track<T>(work: Promise<T>): Promise<T> {
      running.add(work);
      // Swallow here only to keep the registry's own bookkeeping from
      // minting an unhandled rejection; the caller still gets `work`
      // untouched, rejection included.
      void work.catch(() => undefined).finally(() => running.delete(work));
      return work;
    },

    size(): number {
      return running.size;
    },

    async drain(timeoutMs: number): Promise<{ drained: boolean; remaining: number }> {
      const deadline = Date.now() + Math.max(0, timeoutMs);
      while (running.size > 0 && Date.now() < deadline) {
        const settled = Promise.allSettled([...running]);
        const remainingMs = deadline - Date.now();
        let timer: NodeJS.Timeout | undefined;
        const expiry = new Promise<void>((resolve) => {
          timer = setTimeout(resolve, Math.max(0, remainingMs));
          // Never let the deadline timer alone keep the process alive.
          timer.unref?.();
        });
        try {
          await Promise.race([settled, expiry]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      }
      return { drained: running.size === 0, remaining: running.size };
    },
  };
}
