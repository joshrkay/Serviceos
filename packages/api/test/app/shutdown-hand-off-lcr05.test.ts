/**
 * LCR-05 — runShutdown hands every live realtime call to the next process
 * BEFORE it drains.
 *
 * A realtime (media-streams) call has no next webhook: left alone, it is hung
 * up at the teardown. runShutdown therefore asks the live-call registry the
 * stream server fills to hand each leg off (handOffAll → each leg's
 * handOffForShutdown), inside the drain window.
 *
 * Behavioural, in the pattern of shutdown-sweep-drain-overlap.test.ts: the
 * real `createApp()` shutdown sequence runs (in-memory mode). The registry
 * module is the real one, wrapped only to record the instance createApp()
 * builds, so the test can add two live legs to it and watch runShutdown use
 * it. The leg behaviour itself is pinned against real adapters in
 * test/telephony/media-streams/shutdown-hand-off-lcr05.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveRealtimeCalls } from '../../src/telephony/media-streams/live-realtime-calls';

const recorded = vi.hoisted(() => ({
  events: [] as string[],
  registries: [] as LiveRealtimeCalls[],
  handOffTimeouts: [] as number[],
}));

vi.mock('../../src/telephony/media-streams/live-realtime-calls', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/telephony/media-streams/live-realtime-calls')>();
  return {
    ...real,
    createLiveRealtimeCalls: () => {
      const registry = real.createLiveRealtimeCalls();
      const handOffAll = registry.handOffAll.bind(registry);
      const wrapped: LiveRealtimeCalls = {
        ...registry,
        add: registry.add.bind(registry),
        size: registry.size.bind(registry),
        handOffAll: (opts) => {
          recorded.handOffTimeouts.push(opts.timeoutMs);
          return handOffAll(opts);
        },
      };
      recorded.registries.push(wrapped);
      return wrapped;
    },
  };
});

import { createApp } from '../../src/app';
import { SHUTDOWN_HAND_OFF_TIMEOUT_MS } from '../../src/telephony/media-streams/live-realtime-calls';

describe('LCR-05 — runShutdown hands live realtime calls off before it drains', () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;

  beforeEach(() => {
    recorded.events.length = 0;
    recorded.registries.length = 0;
    recorded.handOffTimeouts.length = 0;
    delete process.env.DATABASE_URL;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  });

  it('asks each live leg once to hand off, within the hand-off bound, before the drain completes', async () => {
    const realLog = console.log;
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      if (typeof args[0] === 'string' && args[0].includes('drain complete')) {
        recorded.events.push('drain complete');
      }
      realLog(...args);
    });

    const app = createApp();
    // The one registry createApp() built is the one the stream server fills.
    expect(recorded.registries).toHaveLength(1);
    const registry = recorded.registries[0];
    const legA = {
      handOffForShutdown: vi.fn(async () => {
        recorded.events.push('leg A handed off');
        return true;
      }),
    };
    const legB = {
      handOffForShutdown: vi.fn(async () => {
        recorded.events.push('leg B handed off');
        return true;
      }),
    };
    registry.add(legA);
    registry.add(legB);

    await app.gracefulDrain('test');

    expect(legA.handOffForShutdown).toHaveBeenCalledTimes(1);
    expect(legB.handOffForShutdown).toHaveBeenCalledTimes(1);
    const drained = recorded.events.indexOf('drain complete');
    expect(drained).toBeGreaterThan(-1);
    expect(recorded.events.indexOf('leg A handed off')).toBeLessThan(drained);
    expect(recorded.events.indexOf('leg B handed off')).toBeLessThan(drained);
    // The hand-off is bounded, and its bound comes out of the drain window.
    expect(recorded.handOffTimeouts).toHaveLength(1);
    expect(recorded.handOffTimeouts[0]).toBeGreaterThan(0);
    expect(recorded.handOffTimeouts[0]).toBeLessThanOrEqual(SHUTDOWN_HAND_OFF_TIMEOUT_MS);
  });
});
