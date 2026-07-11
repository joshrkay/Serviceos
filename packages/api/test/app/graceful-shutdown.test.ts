/**
 * ARCH-02 — `uncaughtException` used to bypass the graceful drain sequence
 * entirely (a raw `process.exit(1)` in src/index.ts), dropping all in-flight
 * HTTP + live voice/WS sessions with no drain. The fix routes both fatal
 * in-process errors and SIGTERM/SIGINT through the SAME bounded, idempotent
 * drain (`app.gracefulDrain`, exposed by createApp() in src/app.ts).
 *
 * Two things must hold for that fix to be safe:
 *   1. app.gracefulDrain must be IDEMPOTENT — a concurrent SIGTERM and a
 *      fatal error (or two fatal errors) must not re-enter teardown (double
 *      `pool.end()` / `shutdownRedisClients()` etc.), and must not hang.
 *   2. src/index.ts must not fall back to a raw `process.exit(1)` for
 *      uncaughtException, and its own shutdown path must stay idempotent
 *      and startup-safe. index.ts is a boot script with real side effects
 *      (binds a port, registers process-level signal handlers) so it is not
 *      safely importable in a unit test — that half is covered by a
 *      source-level assertion instead, matching the existing precedent in
 *      test/app/wiring.test.ts for invariants that are cheaper and safer to
 *      assert statically than to boot.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { createApp, type AppWithLifecycle } from '../../src/app';

describe('ARCH-02 — app.gracefulDrain (bounded, idempotent drain)', () => {
  let app: AppWithLifecycle;
  const originalDatabaseUrl = process.env.DATABASE_URL;

  beforeEach(() => {
    // Run createApp() in in-memory mode (no pool to drain, no Redis/analytics
    // registered) so the drain resolves near-instantly instead of needing a
    // real Postgres/Redis to exercise the idempotency contract.
    delete process.env.DATABASE_URL;
    app = createApp();
  });

  afterEach(() => {
    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
  });

  it('exposes gracefulDrain', () => {
    expect(typeof app.gracefulDrain).toBe('function');
  });

  it('is idempotent: concurrent callers get the exact same in-flight promise', () => {
    const first = app.gracefulDrain('uncaughtException');
    const second = app.gracefulDrain('SIGTERM');
    const third = app.gracefulDrain('unhandledRejection');

    // Reference equality — proves the second/third call did NOT re-run
    // teardown (which would double-close the pool/Redis clients), it just
    // observes the same drain the first caller started.
    expect(second).toBe(first);
    expect(third).toBe(first);

    return first;
  });

  it('is bounded: resolves well within DRAIN_TIMEOUT_MS with nothing to drain', async () => {
    const start = Date.now();
    await app.gracefulDrain('test');
    // No live voice sessions and no pool/Redis/analytics registered in this
    // in-memory test config, so the drain loop's own polling (500ms ticks)
    // is the only latency — this should never approach the 25s default
    // DRAIN_TIMEOUT_MS, let alone the 30s SHUTDOWN_FORCE_EXIT_MS backstop.
    expect(Date.now() - start).toBeLessThan(5000);
  });

  it('a second call after the first resolves still returns a settled promise, not a new run', async () => {
    await app.gracefulDrain('first');
    const second = app.gracefulDrain('second');
    // Already resolved — awaiting again must not hang or throw.
    await expect(second).resolves.toBeUndefined();
  });
});

describe('ARCH-02 — src/index.ts fatal-path wiring (source-level)', () => {
  // index.ts binds a real port and registers process-global signal handlers
  // as a side effect of being imported, so it is not booted here — these
  // assertions guard the specific invariants the fix depends on.
  const src = readFileSync(resolve(__dirname, '../../src/index.ts'), 'utf8');

  it('uncaughtException routes through gracefulShutdown, not a raw process.exit', () => {
    const handlerMatch = src.match(
      /process\.on\('uncaughtException',[\s\S]*?\n\}\);/,
    );
    expect(handlerMatch).not.toBeNull();
    const handlerBody = handlerMatch![0];
    expect(handlerBody).toContain('gracefulShutdown(');
    // The regression this guards: the handler used to call process.exit(1)
    // directly and skip the drain entirely.
    expect(handlerBody).not.toMatch(/process\.exit\(/);
  });

  it('gracefulShutdown drains via app.gracefulDrain (the same sequence app.ts uses for SIGTERM)', () => {
    expect(src).toMatch(/\.gracefulDrain\(reason\)/);
  });

  it('gracefulShutdown is idempotency-guarded', () => {
    const fnMatch = src.match(/function gracefulShutdown[\s\S]*?\n\}/);
    expect(fnMatch).not.toBeNull();
    expect(fnMatch![0]).toMatch(/if \(shuttingDown\)/);
    expect(fnMatch![0]).toMatch(/shuttingDown = true;/);
  });

  it('gracefulShutdown is startup-safe (exits immediately if the server never reached "listening")', () => {
    const fnMatch = src.match(/function gracefulShutdown[\s\S]*?\n\}/);
    expect(fnMatch![0]).toMatch(/!serverListening/);
  });

  it('gracefulShutdown arms a bounded force-exit backstop', () => {
    const fnMatch = src.match(/function gracefulShutdown[\s\S]*?\n\}/);
    expect(fnMatch![0]).toMatch(/setTimeout\(\(\) => process\.exit\(exitCode\), FORCE_EXIT_MS\)\.unref\(\)/);
  });

  it('unhandledRejection is preserved as non-fatal (unchanged deliberate behavior)', () => {
    const handlerMatch = src.match(
      /process\.on\('unhandledRejection',[\s\S]*?\n\}\);/,
    );
    expect(handlerMatch).not.toBeNull();
    expect(handlerMatch![0]).not.toContain('gracefulShutdown(');
    // Strip comment lines before checking for a real process.exit() call —
    // the handler deliberately explains in a comment why it does NOT exit.
    const codeOnly = handlerMatch![0]
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
    expect(codeOnly).not.toMatch(/process\.exit\(/);
  });
});
