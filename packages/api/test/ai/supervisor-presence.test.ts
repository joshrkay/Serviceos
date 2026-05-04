import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  isSupervisorPresent,
  setSupervisorPresenceLoader,
  _resetSupervisorPresenceCache,
  SUPERVISOR_PRESENCE_TTL_MS,
} from '../../src/ai/supervisor-presence';

describe('P12-004 — isSupervisorPresent', () => {
  beforeEach(() => {
    _resetSupervisorPresenceCache();
    setSupervisorPresenceLoader(null);
  });

  it('returns true (permissive) when no loader is wired', async () => {
    const result = await isSupervisorPresent('tenant-A');
    expect(result).toBe(true);
  });

  it('delegates to the wired loader and returns its boolean', async () => {
    const loader = vi.fn(async (tenantId: string) => tenantId === 'present');
    setSupervisorPresenceLoader(loader);

    expect(await isSupervisorPresent('present')).toBe(true);
    expect(await isSupervisorPresent('absent')).toBe(false);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('caches results per tenant for the configured TTL', async () => {
    const loader = vi.fn(async () => true);
    setSupervisorPresenceLoader(loader);

    // First call: hits the loader.
    await isSupervisorPresent('tenant-A', 1_000);
    expect(loader).toHaveBeenCalledTimes(1);

    // Second call within TTL: cache hit.
    await isSupervisorPresent('tenant-A', 1_000 + 5_000);
    expect(loader).toHaveBeenCalledTimes(1);

    // Different tenant within TTL: separate cache entry, hits loader.
    await isSupervisorPresent('tenant-B', 1_000 + 5_000);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('refetches after the TTL window elapses', async () => {
    let supervisorPresent = true;
    const loader = vi.fn(async () => supervisorPresent);
    setSupervisorPresenceLoader(loader);

    await isSupervisorPresent('tenant-A', 1_000);
    expect(loader).toHaveBeenCalledTimes(1);

    // Flip the underlying state; cache still holds the old answer.
    supervisorPresent = false;
    await isSupervisorPresent('tenant-A', 1_000 + 1_000);
    expect(loader).toHaveBeenCalledTimes(1); // cache hit; still true

    // Advance past TTL — loader runs again, picks up the new state.
    const result = await isSupervisorPresent(
      'tenant-A',
      1_000 + SUPERVISOR_PRESENCE_TTL_MS + 1,
    );
    expect(loader).toHaveBeenCalledTimes(2);
    expect(result).toBe(false);
  });

  it('falls back to permissive (true) when the loader throws', async () => {
    const loader = vi.fn(async () => {
      throw new Error('db down');
    });
    setSupervisorPresenceLoader(loader);

    const result = await isSupervisorPresent('tenant-A');
    expect(result).toBe(true);
    expect(loader).toHaveBeenCalledTimes(1);
  });
});
