/**
 * #1736 — post-call scoring sweep (P0-009 cross-tenant pattern).
 *
 * app.ts drives `handle()` on an interval behind the leader advisory lock
 * (SWEEP_LOCK.callScoring). Per tenant:
 *   1. skip unless `tenant_settings.call_scoring_enabled` (OFF by default);
 *   2. take up to `perTenantLimit` eligible calls (ended inbound, disclosure
 *      played, billable, transcript present — #1602's predicate) from the
 *      look-back window that have no score yet, newest first;
 *   3. score each through `scoreVoiceCall` (which re-checks every gate) and
 *      audit `voice_call.scored`.
 * Failure isolation: a throwing tenant is logged and skipped; a failing call is
 * counted and its siblings still score. The look-back window means turning the
 * flag on scores recent calls, not the tenant's whole history.
 */
import { createAuditEvent, type AuditRepository } from '../audit/audit';
import type { CallScoreStore } from '../voice/scoring/call-score-store';
import type { VoiceCallScorer } from '../voice/scoring/score-voice-call';

export const CALL_SCORING_INTERVAL_MS = 15 * 60 * 1000;
export const CALL_SCORED_EVENT = 'voice_call.scored';
const DEFAULT_LOOKBACK_HOURS = 24;
/** Cost bound: one LLM call per scored call, at most this many per tenant per tick. */
const DEFAULT_PER_TENANT_LIMIT = 10;

interface ScoringLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface CallScoringWorkerDeps {
  store: CallScoreStore;
  scorer: VoiceCallScorer;
  listTenantIds: () => Promise<string[]>;
  logger: ScoringLogger;
  auditRepo?: Pick<AuditRepository, 'create'>;
  now?: () => Date;
  lookbackHours?: number;
  perTenantLimit?: number;
}

export interface CallScoringRunResult {
  tenantsSwept: number;
  scored: number;
  skipped: number;
  failures: number;
}

export interface CallScoringWorker {
  handle(): Promise<CallScoringRunResult>;
}

export function createCallScoringWorker(deps: CallScoringWorkerDeps): CallScoringWorker {
  const now = deps.now ?? (() => new Date());
  const lookbackMs = (deps.lookbackHours ?? DEFAULT_LOOKBACK_HOURS) * 60 * 60 * 1000;
  const limit = deps.perTenantLimit ?? DEFAULT_PER_TENANT_LIMIT;

  async function sweepTenant(tenantId: string, at: Date, result: CallScoringRunResult): Promise<void> {
    if (!(await deps.store.isEnabled(tenantId))) return;
    result.tenantsSwept += 1;
    const candidates = await deps.store.listUnscoredCandidates(tenantId, {
      endedSince: new Date(at.getTime() - lookbackMs),
      endedBefore: at,
      limit,
    });
    for (const sessionId of candidates) {
      try {
        const outcome = await deps.scorer.scoreVoiceCall(tenantId, sessionId);
        if (outcome.status !== 'scored') {
          result.skipped += 1;
          continue;
        }
        result.scored += 1;
        if (deps.auditRepo) {
          await deps.auditRepo.create(
            createAuditEvent({
              tenantId,
              actorId: 'system:call-scoring',
              actorRole: 'system',
              eventType: CALL_SCORED_EVENT,
              entityType: 'voice_session',
              entityId: sessionId,
              metadata: {
                score: outcome.score.score,
                rubricVersion: outcome.score.rubricVersion,
                flagCount: outcome.score.flags.length,
              },
            }),
          );
        }
      } catch (err) {
        result.failures += 1;
        deps.logger.warn('call-scoring: call scoring failed, skipping', {
          tenantId,
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  async function handle(): Promise<CallScoringRunResult> {
    const at = now();
    const result: CallScoringRunResult = { tenantsSwept: 0, scored: 0, skipped: 0, failures: 0 };
    for (const tenantId of await deps.listTenantIds()) {
      try {
        await sweepTenant(tenantId, at, result);
      } catch (err) {
        result.failures += 1;
        deps.logger.error('call-scoring: tenant sweep failed, continuing', {
          tenantId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (result.scored > 0 || result.failures > 0) {
      deps.logger.info('call-scoring: pass complete', { ...result });
    }
    return result;
  }

  return { handle };
}
