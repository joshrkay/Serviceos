/**
 * Regression: booting createApp() with a DATABASE_URL that nothing is
 * listening on must not produce an UNHANDLED REJECTION.
 *
 * The boot-time feature-flag hydration is a void'd fire-and-forget async IIFE
 * in app.ts. Nothing awaits it, so nothing can catch what it throws: an
 * unguarded `await hydrateStoreFromRepository(...)` against an unreachable
 * Postgres rejected with ECONNREFUSED and escaped as a process-level unhandled
 * rejection. In CI (no Postgres on 5432) that failed the ENTIRE vitest run
 * with "Unhandled Errors" even though every test passed, which in turn kept
 * `needs: [test]` deploy jobs permanently SKIPPED.
 *
 * Hydration failing with no database is a legitimate degraded state — the flag
 * store simply stays empty and every flag reads false — so it must be caught
 * and logged, never left to escape.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createApp, type AppWithLifecycle } from '../../src/app';
import { resetConfig } from '../../src/shared/config';

// Port 1 is privileged and never bound, so connect() fails fast and
// deterministically with ECONNREFUSED — the exact CI shape.
const UNREACHABLE_DATABASE_URL = 'postgres://serviceos:pw@127.0.0.1:1/serviceos_test';

const ENV_KEYS = ['DATABASE_URL', 'DB_SSL', 'PROCESS_ROLE', 'RLS_RUNTIME_ROLE'] as const;

describe('createApp() with an unreachable database', () => {
  const originalEnv = new Map<string, string | undefined>(
    ENV_KEYS.map((k) => [k, process.env[k]]),
  );
  const rejections: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    rejections.push(reason);
  };
  let app: AppWithLifecycle;

  beforeAll(async () => {
    process.env.DATABASE_URL = UNREACHABLE_DATABASE_URL;
    process.env.DB_SSL = 'false';
    // Web role only: no background worker sweeps, so the only boot-time work
    // that reaches the database is the feature-flag seed + hydration.
    process.env.PROCESS_ROLE = 'web';
    delete process.env.RLS_RUNTIME_ROLE;
    resetConfig();

    process.on('unhandledRejection', onUnhandled);
    app = createApp();
    // The connect is refused immediately; give the IIFE's microtasks and
    // Node's unhandledRejection emission (end of the next macrotask) room.
    await new Promise((r) => setTimeout(r, 1000));
  });

  afterAll(async () => {
    process.off('unhandledRejection', onUnhandled);
    await app?.gracefulDrain?.('test-cleanup');
    resetConfig();
    for (const [k, v] of originalEnv) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('boots without throwing', () => {
    expect(app).toBeTruthy();
  });

  it('emits NO unhandled rejection from boot-time feature-flag hydration', () => {
    const described = rejections.map((r) =>
      r instanceof Error ? `${r.message}\n${r.stack ?? ''}` : String(r),
    );
    expect(described).toEqual([]);
  });
});
