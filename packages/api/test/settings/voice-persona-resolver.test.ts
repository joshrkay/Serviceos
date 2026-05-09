import { describe, it, expect, vi } from 'vitest';
import { createVoicePersonaResolver } from '../../src/settings/voice-persona-resolver';
import type { SettingsRepository } from '../../src/settings/settings';

function makeRepo(overrides: Partial<SettingsRepository> = {}): SettingsRepository {
  return {
    findByTenant: vi.fn().mockResolvedValue(null),
    create: vi.fn(),
    update: vi.fn(),
    ...overrides,
  } as unknown as SettingsRepository;
}

describe('createVoicePersonaResolver', () => {
  describe('persona extraction', () => {
    it('returns null when settings not found', async () => {
      const repo = makeRepo({ findByTenant: vi.fn().mockResolvedValue(null) });
      const resolve = createVoicePersonaResolver(repo, { ttlMs: 0 });
      expect(await resolve('tenant-1')).toBeNull();
    });

    it('returns null when neither field is set', async () => {
      const repo = makeRepo({
        findByTenant: vi.fn().mockResolvedValue({ businessName: 'Acme' }),
      });
      const resolve = createVoicePersonaResolver(repo, { ttlMs: 0 });
      expect(await resolve('tenant-1')).toBeNull();
    });

    it('returns agentName when voiceAgentName is set', async () => {
      const repo = makeRepo({
        findByTenant: vi.fn().mockResolvedValue({ voiceAgentName: 'Alex' }),
      });
      const resolve = createVoicePersonaResolver(repo, { ttlMs: 0 });
      expect(await resolve('tenant-1')).toEqual({ agentName: 'Alex' });
    });

    it('returns greeting when voiceGreeting is set', async () => {
      const repo = makeRepo({
        findByTenant: vi.fn().mockResolvedValue({ voiceGreeting: 'Hey there!' }),
      });
      const resolve = createVoicePersonaResolver(repo, { ttlMs: 0 });
      expect(await resolve('tenant-1')).toEqual({ greeting: 'Hey there!' });
    });

    it('returns both when both fields are set', async () => {
      const repo = makeRepo({
        findByTenant: vi.fn().mockResolvedValue({ voiceAgentName: 'Alex', voiceGreeting: 'Hey!' }),
      });
      const resolve = createVoicePersonaResolver(repo, { ttlMs: 0 });
      expect(await resolve('tenant-1')).toEqual({ agentName: 'Alex', greeting: 'Hey!' });
    });

    it('returns null on empty tenantId', async () => {
      const repo = makeRepo();
      const resolve = createVoicePersonaResolver(repo, { ttlMs: 0 });
      expect(await resolve('')).toBeNull();
      expect(repo.findByTenant).not.toHaveBeenCalled();
    });

    it('is failure-open: returns null when repo throws', async () => {
      const repo = makeRepo({
        findByTenant: vi.fn().mockRejectedValue(new Error('db down')),
      });
      const resolve = createVoicePersonaResolver(repo, { ttlMs: 0 });
      expect(await resolve('tenant-1')).toBeNull();
    });
  });

  describe('TTL cache', () => {
    it('caches result within TTL window', async () => {
      const findByTenant = vi.fn().mockResolvedValue({ voiceAgentName: 'Alex' });
      const repo = makeRepo({ findByTenant });
      let t = 0;
      const resolve = createVoicePersonaResolver(repo, { ttlMs: 60_000, now: () => t });

      const first = await resolve('tenant-1');
      const second = await resolve('tenant-1');

      expect(findByTenant).toHaveBeenCalledTimes(1);
      expect(first).toEqual({ agentName: 'Alex' });
      expect(second).toEqual({ agentName: 'Alex' });
    });

    it('re-fetches after TTL expires', async () => {
      const findByTenant = vi.fn().mockResolvedValue({ voiceAgentName: 'Alex' });
      const repo = makeRepo({ findByTenant });
      let t = 0;
      const resolve = createVoicePersonaResolver(repo, { ttlMs: 1000, now: () => t });

      await resolve('tenant-1');
      t = 2000; // expire the cache entry
      await resolve('tenant-1');

      expect(findByTenant).toHaveBeenCalledTimes(2);
    });

    it('caches null persona (settings not found)', async () => {
      const findByTenant = vi.fn().mockResolvedValue(null);
      const repo = makeRepo({ findByTenant });
      let t = 0;
      const resolve = createVoicePersonaResolver(repo, { ttlMs: 60_000, now: () => t });

      await resolve('tenant-1');
      await resolve('tenant-1');

      expect(findByTenant).toHaveBeenCalledTimes(1);
    });

    it('evicts oldest entries when maxEntries exceeded', async () => {
      const repo = makeRepo({ findByTenant: vi.fn().mockResolvedValue(null) });
      const resolve = createVoicePersonaResolver(repo, { ttlMs: 60_000, maxEntries: 2 });

      await resolve('tenant-a');
      await resolve('tenant-b');
      await resolve('tenant-c'); // should evict tenant-a

      // Now tenant-a should be evicted and re-fetched
      await resolve('tenant-a');
      expect(repo.findByTenant).toHaveBeenCalledTimes(4); // a, b, c, a again
    });
  });
});
