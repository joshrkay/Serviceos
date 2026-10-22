/**
 * U4 (Part E punch #1) — tenant timezone for spoken-datetime resolution,
 * resolved ONCE per session (E1-script precedent: settings read per session,
 * not per utterance). Keyed by the live session OBJECT so entries are
 * garbage-collected with the session — no eviction hook needed. `undefined`
 * (no settings repo, no configured zone, a zone this runtime cannot resolve,
 * or a settings-read failure) is cached too: the session then refuses to
 * resolve spoken times rather than guessing a zone (B5.5 precedent), and the
 * next session retries the read. A caller with no session to key on (the
 * in-app adapter's rare session-less path) gets an unmemoized read —
 * correct, just uncached.
 *
 * #1601 step 2 — the one copy. The phone processor and the in-app adapter
 * each carried this verbatim; both now build their resolver here. The only
 * difference between the copies was that the in-app one swallowed a failed
 * read silently — the processor's warn line is kept (log-only).
 */
import type { VoiceSession } from '../../agents/customer-calling/voice-session-store';
import type { SettingsRepository } from '../../../settings/settings';
import { isRuntimeTimezone } from '../../../shared/timezone';
import { createLogger } from '../../../logging/logger';

const logger = createLogger({
  service: 'ai.voice-turn.session-timezone',
  environment: process.env.NODE_ENV || 'development',
});

export type SessionTimezoneResolver = (
  session: VoiceSession | undefined,
  tenantId: string,
) => Promise<string | undefined>;

export interface SessionTimezoneDeps {
  settingsRepo?: Pick<SettingsRepository, 'findByTenant'>;
}

/**
 * Build one resolver per processor / adapter instance. `deps.settingsRepo`
 * is read at call time (not captured), exactly as the inlined copies did.
 */
export function createSessionTimezoneResolver(deps: SessionTimezoneDeps): SessionTimezoneResolver {
  const sessionTimezones = new WeakMap<VoiceSession, Promise<string | undefined>>();
  return (session, tenantId) => {
    const cached = session ? sessionTimezones.get(session) : undefined;
    if (cached) return cached;
    const pending = (async () => {
      if (!deps.settingsRepo) return undefined;
      try {
        const settings = await deps.settingsRepo.findByTenant(tenantId);
        const tz = settings?.timezone;
        return typeof tz === 'string' && isRuntimeTimezone(tz.trim()) ? tz.trim() : undefined;
      } catch (err) {
        logger.warn('tenant timezone lookup failed; spoken times stay unresolved', {
          tenantId,
          sessionId: session?.id,
          error: err instanceof Error ? err.message : String(err),
        });
        return undefined;
      }
    })();
    if (session) sessionTimezones.set(session, pending);
    return pending;
  };
}
