/**
 * Epic 12.6 — Weekly feedback email sweeper.
 *
 * Once per completed week, for each tenant that hasn't opted out, build a
 * performance snapshot, derive wins/misses/actions (LLM gateway when wired,
 * deterministic otherwise), and email the owner. Mirrors the HFCR weekly
 * sweep: a daily tick (restart-safe) with a per-week idempotency guard, here
 * keyed off an audit event rather than a dedicated ledger table.
 *
 * Idempotency + audit in one: we record a `weekly_feedback_email.sent` audit
 * event keyed by entityId = the week's Monday date; the top-of-loop
 * findByEntity check makes a re-run (or the next daily tick) a no-op. This
 * also satisfies the "all mutations emit audit events" invariant.
 *
 * Read-only AI: suggestions are advisory email text. Nothing here executes a
 * proposal — the no-auto-execute invariant holds.
 */
import { Logger } from '../logging/logger';
import { AuditRepository, createAuditEvent } from '../audit/audit';
import {
  deterministicSuggestions,
  type WeeklyFeedbackSnapshot,
  type WeeklySuggestions,
} from '../digest/weekly-feedback';
import { renderWeeklyFeedbackEmail } from '../digest/weekly-feedback-renderer';
import { startOfWeekUTC } from './hfcr-weekly-send-worker';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const ENTITY_TYPE = 'weekly_feedback_email';
const EVENT_TYPE_SENT = 'weekly_feedback_email.sent';

export interface WeeklyFeedbackEmailArgs {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface WeeklyFeedbackDeps {
  auditRepo: AuditRepository;
  buildSnapshot: (tenantId: string, weekStart: Date, weekEnd: Date) => Promise<WeeklyFeedbackSnapshot>;
  /** Owner email (the digest recipient), or null when none is configured. */
  resolveOwnerEmail: (tenantId: string) => Promise<string | null>;
  /** Opt-out gate — false skips the tenant. */
  isFeedbackEnabled: (tenantId: string) => Promise<boolean>;
  sendEmail: (args: WeeklyFeedbackEmailArgs) => Promise<unknown>;
  listTenantIds: () => Promise<string[]>;
  logger: Logger;
  /** Optional gateway-backed suggestions; falls back to deterministic on null/throw. */
  composeSuggestions?: (
    tenantId: string,
    snapshot: WeeklyFeedbackSnapshot,
  ) => Promise<WeeklySuggestions | null>;
  /** Optional business name for the email greeting. */
  resolveBusinessName?: (tenantId: string) => Promise<string | null>;
  now?: () => Date;
}

function dateString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** A week with no money, jobs, estimates, calls, or leads isn't worth an email. */
function isEmptyWeek(s: WeeklyFeedbackSnapshot): boolean {
  return (
    s.revenueCents <= 0 &&
    s.jobsCompleted === 0 &&
    s.jobsBooked === 0 &&
    s.estimatesSent === 0 &&
    s.callsAnswered === 0 &&
    s.newLeads === 0
  );
}

export async function runWeeklyFeedbackSweep(
  deps: WeeklyFeedbackDeps,
): Promise<{ tenants: number; sent: number; failed: number }> {
  const now = (deps.now ?? (() => new Date()))();

  let tenantIds: string[];
  try {
    tenantIds = await deps.listTenantIds();
  } catch (err) {
    deps.logger.error('Weekly feedback: failed to list tenants', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { tenants: 0, sent: 0, failed: 0 };
  }

  // Summarize the most recently COMPLETED week: [prevMonday, thisMonday).
  const thisMonday = startOfWeekUTC(now);
  const weekStart = new Date(thisMonday.getTime() - 7 * MS_PER_DAY);
  const weekEnd = thisMonday;
  const weekKey = dateString(weekStart);

  let sent = 0;
  let failed = 0;

  for (const tenantId of tenantIds) {
    try {
      // Idempotency: already sent this week's email.
      const already = await deps.auditRepo.findByEntity(tenantId, ENTITY_TYPE, weekKey);
      if (already.length > 0) continue;

      if (!(await deps.isFeedbackEnabled(tenantId))) continue;

      const ownerEmail = await deps.resolveOwnerEmail(tenantId);
      if (!ownerEmail) continue;

      const snapshot = await deps.buildSnapshot(tenantId, weekStart, weekEnd);
      if (isEmptyWeek(snapshot)) continue; // no dead-week spam

      let suggestions = deterministicSuggestions(snapshot);
      if (deps.composeSuggestions) {
        try {
          const ai = await deps.composeSuggestions(tenantId, snapshot);
          if (ai) suggestions = ai;
        } catch (err) {
          deps.logger.warn('Weekly feedback: suggestion composer failed, using deterministic', {
            tenantId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      const businessName = deps.resolveBusinessName
        ? (await deps.resolveBusinessName(tenantId)) ?? undefined
        : undefined;
      const email = renderWeeklyFeedbackEmail(snapshot, suggestions, { businessName });

      // Deliverable-first: send, then record. A transient send failure throws
      // into the per-tenant catch and writes no marker, so the next daily tick
      // retries this week. The runAsLeader lock + the top-of-loop check keep
      // this to one send per week.
      await deps.sendEmail({ to: ownerEmail, subject: email.subject, text: email.text, html: email.html });

      await deps.auditRepo.create(
        createAuditEvent({
          tenantId,
          actorId: 'system',
          actorRole: 'system',
          eventType: EVENT_TYPE_SENT,
          entityType: ENTITY_TYPE,
          entityId: weekKey,
          metadata: { revenueCents: snapshot.revenueCents, jobsCompleted: snapshot.jobsCompleted },
        }),
      );
      sent++;
    } catch (err) {
      failed++;
      deps.logger.warn('Weekly feedback: tenant failed', {
        tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  deps.logger.info('Weekly feedback sweep completed', { tenants: tenantIds.length, sent, failed });
  return { tenants: tenantIds.length, sent, failed };
}
