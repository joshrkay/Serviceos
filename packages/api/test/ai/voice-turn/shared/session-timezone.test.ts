/**
 * #1601 step 2 — the once-per-session tenant-timezone read has ONE home.
 *
 * U4 resolved the tenant zone once per session in the phone processor; the
 * in-app adapter carried its own copy. Both must agree on the contract:
 *   - the configured zone, trimmed, when it is a zone this runtime knows;
 *   - `undefined` when no settings repo is wired, no zone is configured, the
 *     zone is one the runtime cannot resolve, or the read fails — the turn
 *     then refuses to resolve spoken times rather than guessing a zone;
 *   - ONE settings read per live session (the failure is cached too), and a
 *     fresh read for the next session.
 * A caller with no session object (the in-app adapter's optional memo key)
 * gets an uncached read.
 */
import { describe, it, expect, vi } from 'vitest';
import { createSessionTimezoneResolver } from '../../../../src/ai/voice-turn/shared/session-timezone';
import { VoiceSessionStore } from '../../../../src/ai/agents/customer-calling/voice-session-store';
import type { SettingsRepository } from '../../../../src/settings/settings';

const TENANT = 'tenant-1601-tz';

function settingsRepo(findByTenant: (tenantId: string) => Promise<unknown>) {
  return { findByTenant: vi.fn(findByTenant) } as unknown as SettingsRepository & {
    findByTenant: ReturnType<typeof vi.fn>;
  };
}

function session(store: VoiceSessionStore) {
  return store.create(TENANT, 'telephony', { callSid: `CA-${Math.random().toString(36).slice(2, 8)}` });
}

describe('createSessionTimezoneResolver (shared)', () => {
  const store = new VoiceSessionStore({ startInterval: false });

  it('returns the configured zone, trimmed, when the runtime knows it', async () => {
    const repo = settingsRepo(async () => ({ timezone: ' America/Phoenix ' }));
    const resolve = createSessionTimezoneResolver({ settingsRepo: repo });
    await expect(resolve(session(store), TENANT)).resolves.toBe('America/Phoenix');
  });

  it('is undefined with no settings repo, no configured zone, or a zone the runtime cannot resolve', async () => {
    await expect(createSessionTimezoneResolver({})(session(store), TENANT)).resolves.toBeUndefined();
    const none = createSessionTimezoneResolver({ settingsRepo: settingsRepo(async () => ({})) });
    await expect(none(session(store), TENANT)).resolves.toBeUndefined();
    const bogus = createSessionTimezoneResolver({
      settingsRepo: settingsRepo(async () => ({ timezone: 'Mars/Olympus_Mons' })),
    });
    await expect(bogus(session(store), TENANT)).resolves.toBeUndefined();
  });

  it('a failed settings read resolves undefined instead of throwing', async () => {
    const repo = settingsRepo(async () => {
      throw new Error('pg down');
    });
    const resolve = createSessionTimezoneResolver({ settingsRepo: repo });
    await expect(resolve(session(store), TENANT)).resolves.toBeUndefined();
  });

  it('reads settings ONCE per session (a failure is cached too) and again for the next session', async () => {
    let calls = 0;
    const repo = settingsRepo(async () => {
      calls += 1;
      if (calls === 1) throw new Error('first read fails');
      return { timezone: 'America/Chicago' };
    });
    const resolve = createSessionTimezoneResolver({ settingsRepo: repo });
    const first = session(store);
    await expect(resolve(first, TENANT)).resolves.toBeUndefined();
    await expect(resolve(first, TENANT)).resolves.toBeUndefined();
    expect(repo.findByTenant).toHaveBeenCalledTimes(1);

    await expect(resolve(session(store), TENANT)).resolves.toBe('America/Chicago');
    expect(repo.findByTenant).toHaveBeenCalledTimes(2);
  });

  it('with no session to key on, every call reads settings afresh', async () => {
    const repo = settingsRepo(async () => ({ timezone: 'America/Denver' }));
    const resolve = createSessionTimezoneResolver({ settingsRepo: repo });
    await expect(resolve(undefined, TENANT)).resolves.toBe('America/Denver');
    await expect(resolve(undefined, TENANT)).resolves.toBe('America/Denver');
    expect(repo.findByTenant).toHaveBeenCalledTimes(2);
  });
});
