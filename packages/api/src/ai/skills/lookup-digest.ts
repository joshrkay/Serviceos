/**
 * RV-064 — `lookup_digest` voice skill ("read me my day").
 *
 * Owner-scoped, read-only — speaks the stored end-of-day digest
 * narrative (RV-060/061). Reads through the digest repo ONLY (no digest
 * computation or writes here — the worker owns generation):
 *
 *   - today's digest when it exists (`findByTenantAndDate`),
 *   - otherwise the most recent one (`findLatest`), prefixed with its
 *     date so the owner knows they're hearing yesterday's close-out,
 *   - narrative empty → falls back to the digest service's own
 *     deterministic `buildFallbackNarrative` over the stored payload
 *     counts (the same fallback the SMS path uses when the LLM is down).
 */
import type { DailyDigestRecord, DailyDigestRepository } from '../../digest/digest-service';
import { buildFallbackNarrative, localDateString } from '../../digest/digest-service';
import type { LookupEventService } from '../../lookup-events/lookup-event-service';

export interface LookupDigestInput {
  tenantId: string;
  /** IANA timezone used to resolve "today". Defaults to America/New_York
   *  (the digest's own default). */
  timezone?: string;
  /** Injectable clock — pinned by tests. Defaults to now. */
  now?: Date;
  /** Voice session this lookup runs inside. Used for the audit row. */
  sessionId?: string;
}

export interface LookupDigestDeps {
  digestRepo: DailyDigestRepository;
  /** Optional — when wired the skill writes a `lookup_events` audit row. */
  lookupEvents?: LookupEventService;
}

export type LookupDigestResult =
  | {
      status: 'found';
      summary: string;
      data: { digestDate: string; narrativeSource: 'stored' | 'fallback' };
    }
  | { status: 'none'; summary: string; data: Record<string, never> }
  | { status: 'error'; summary: string; data: { error: string } };

const DEFAULT_TIMEZONE = 'America/New_York';

/** "June 10" — spoken date for a stale digest, parsed DST-safely as UTC noon. */
function spokenDate(digestDate: string): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${digestDate}T12:00:00.000Z`));
}

export async function lookupDigest(
  input: LookupDigestInput,
  deps: LookupDigestDeps,
): Promise<LookupDigestResult> {
  const start = Date.now();
  const timezone = input.timezone ?? DEFAULT_TIMEZONE;
  const now = input.now ?? new Date();

  const recordEvent = async (
    resultStatus: 'found' | 'none' | 'error',
    summary: string,
  ): Promise<void> => {
    if (!deps.lookupEvents) return;
    try {
      await deps.lookupEvents.record({
        tenantId: input.tenantId,
        intent: 'lookup_digest',
        sessionId: input.sessionId,
        latencyMs: Date.now() - start,
        resultStatus,
        resultCount: resultStatus === 'found' ? 1 : 0,
        summary,
      });
    } catch {
      // best-effort: skill must never fail on audit write
    }
  };

  try {
    const today = localDateString(now, timezone);
    let record: DailyDigestRecord | null = await deps.digestRepo.findByTenantAndDate(
      input.tenantId,
      today,
    );
    if (!record) record = await deps.digestRepo.findLatest(input.tenantId);

    if (!record) {
      const summary =
        "I don't have a daily digest for you yet — one is generated at the end of each day.";
      await recordEvent('none', summary);
      return { status: 'none', summary, data: {} };
    }

    const storedNarrative = record.narrative?.trim();
    const narrativeSource: 'stored' | 'fallback' = storedNarrative ? 'stored' : 'fallback';
    const narrative = storedNarrative || buildFallbackNarrative(record.payload);
    const summary =
      record.digestDate === today
        ? narrative
        : `Here's your latest digest, from ${spokenDate(record.digestDate)}: ${narrative}`;

    await recordEvent('found', summary);
    return {
      status: 'found',
      summary,
      data: { digestDate: record.digestDate, narrativeSource },
    };
  } catch (err) {
    const message = "I'm having trouble pulling up your digest right now.";
    await recordEvent('error', message);
    return {
      status: 'error',
      summary: message,
      data: { error: err instanceof Error ? err.message : String(err) },
    };
  }
}
