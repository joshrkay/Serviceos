/**
 * TI-02 follow-up — page on ANY increase of
 * `gateway_llm_call_in_transaction_total`.
 *
 * `LLMGateway.complete` refuses an LLM call started while a tenant transaction
 * holds a pooled connection: under NODE_ENV=test it throws, anywhere else it
 * logs an error and counts this metric so production traffic never breaks.
 * Each such call pins a connection (and under PgBouncer a server backend) for
 * the whole call, and about a pool's worth of them stall every tenant's /api,
 * so a non-zero count is a shipped route that belongs on LLM_LONG_CALL_ROUTES.
 * Until this check, nothing evaluated the counter.
 *
 * The counter is a prom-client counter, so it lives in the process that made
 * the call: web for an in-request call, worker for an explicit unit of work.
 * The leader-locked SLO monitor runs only on the worker and cannot see the web
 * process's count, so this check runs in EVERY process role (app.ts registers
 * it with the observability intervals, not the worker loops) and each process
 * pages for its own calls. It pages through `alertOperator` (Sentry error
 * event, plus the operator SMS when ALERT_SMS_TO is set), whose per-rule
 * cooldown keeps a hot route to one page per SLO_ALERT_COOLDOWN_MIN per
 * process. The Prometheus form of the same rule, for a metrics backend, is in
 * docs/runbooks/slo-alerts.md.
 */
import type { Logger } from '../logging/logger';
import type { AlertOperatorFn, OperatorAlert } from './alert-operator';
import { gatewayLlmCallInTransactionTotal } from './metrics';

/** Stable rule key: the alertOperator cooldown key and the page's rule name. */
export const LLM_CALL_IN_TRANSACTION_RULE = 'gateway_llm_call_in_transaction';

/** Check cadence. The read is an in-process counter snapshot, so it is cheap. */
export const LLM_CALL_IN_TRANSACTION_CHECK_INTERVAL_MS = 60 * 1000;

/** Cumulative count per `task_type` label. */
export type LlmCallInTransactionCounts = ReadonlyMap<string, number>;

export interface LlmCallInTransactionFinding {
  rule: string;
  breached: boolean;
  /** Calls counted since the previous read, all task types. */
  value: number;
  summary: string;
  details: { increase: number; taskTypes: string };
  severity: OperatorAlert['severity'];
}

/**
 * Compare two cumulative reads. Any increase breaches; the details name each
 * task type that moved, largest increase first.
 */
export function evaluateLlmCallInTransaction(
  previous: LlmCallInTransactionCounts,
  current: LlmCallInTransactionCounts,
): LlmCallInTransactionFinding {
  const moved: Array<[string, number]> = [];
  for (const [taskType, count] of current) {
    const increase = count - (previous.get(taskType) ?? 0);
    if (increase > 0) moved.push([taskType, increase]);
  }
  moved.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const increase = moved.reduce((sum, [, n]) => sum + n, 0);
  return {
    rule: LLM_CALL_IN_TRANSACTION_RULE,
    breached: increase > 0,
    value: increase,
    summary:
      `${increase} LLM call(s) started inside a tenant transaction, each holding a pooled connection ` +
      'for the whole call; the route belongs on LLM_LONG_CALL_ROUTES (the gateway error log names the call site)',
    details: { increase, taskTypes: moved.map(([t, n]) => `${t}=${n}`).join(', ') },
    severity: 'critical',
  };
}

/** Snapshot the real counter. */
export async function readLlmCallInTransactionCounts(): Promise<Map<string, number>> {
  const snapshot = await gatewayLlmCallInTransactionTotal.get();
  const out = new Map<string, number>();
  for (const v of snapshot.values) {
    const taskType = String(v.labels.task_type ?? 'unknown');
    out.set(taskType, (out.get(taskType) ?? 0) + v.value);
  }
  return out;
}

export interface LlmCallInTransactionCheckDeps {
  alert: AlertOperatorFn;
  logger: Pick<Logger, 'error'>;
  /** Test seam; defaults to the real counter. */
  readCounts?: () => Promise<LlmCallInTransactionCounts>;
}

/**
 * Build the per-process check. The first read compares against zero (the
 * counter starts at zero when the process boots), so calls counted before the
 * first tick still page. Never throws: a failed read is logged and the next
 * read compares against the last good one.
 */
export function createLlmCallInTransactionCheck(
  deps: LlmCallInTransactionCheckDeps,
): () => Promise<void> {
  const readCounts = deps.readCounts ?? readLlmCallInTransactionCounts;
  let previous: LlmCallInTransactionCounts = new Map();
  return async () => {
    try {
      const current = await readCounts();
      const finding = evaluateLlmCallInTransaction(previous, current);
      previous = current;
      if (!finding.breached) return;
      await deps.alert({
        severity: finding.severity,
        rule: finding.rule,
        summary: finding.summary,
        details: finding.details,
      });
    } catch (err) {
      deps.logger.error('LLM-call-in-transaction check failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
}
