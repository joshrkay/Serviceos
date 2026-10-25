/**
 * TI-02 follow-up — page on ANY increase of
 * `gateway_llm_call_in_transaction_total`.
 *
 * In production the gateway's in-transaction guard only logs and counts (it
 * must never break traffic), and nothing evaluated the counter, so a route
 * that started holding the request transaction across an LLM call shipped
 * silently. The counter lives in the process that made the call (web for an
 * in-request call, worker for a unit of work), so the check runs in every
 * process role and pages through the same `alertOperator` seam as the SLO
 * monitor (Sentry error event + operator SMS, per-rule cooldown).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  createLlmCallInTransactionCheck,
  evaluateLlmCallInTransaction,
  LLM_CALL_IN_TRANSACTION_RULE,
} from '../../src/monitoring/llm-call-in-transaction-alert';
import { createAlertOperator, type OperatorAlert } from '../../src/monitoring/alert-operator';
import { gatewayLlmCallInTransactionTotal } from '../../src/monitoring/metrics';
import type { SentryClient } from '../../src/monitoring/sentry';
import type { Logger } from '../../src/logging/logger';

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child() {
    return this;
  },
};

const counts = (entries: Record<string, number>): Map<string, number> => new Map(Object.entries(entries));

describe('evaluateLlmCallInTransaction — any increase breaches', () => {
  it('no increase since the last read: not breached', () => {
    const r = evaluateLlmCallInTransaction(counts({ draft: 2 }), counts({ draft: 2 }));
    expect(r.breached).toBe(false);
    expect(r.value).toBe(0);
  });

  it('a single new call breaches, critical, naming the task type', () => {
    const r = evaluateLlmCallInTransaction(counts({}), counts({ classify_intent: 1 }));
    expect(r.breached).toBe(true);
    expect(r.value).toBe(1);
    expect(r.severity).toBe('critical');
    expect(r.rule).toBe(LLM_CALL_IN_TRANSACTION_RULE);
    expect(r.summary).toMatch(/LLM_LONG_CALL_ROUTES/);
    expect(r.details).toMatchObject({ increase: 1, taskTypes: 'classify_intent=1' });
  });

  it('sums increases across task types and ignores unchanged ones', () => {
    const r = evaluateLlmCallInTransaction(
      counts({ a: 1, b: 5, c: 2 }),
      counts({ a: 1, b: 7, c: 2, d: 3 }),
    );
    expect(r.breached).toBe(true);
    expect(r.value).toBe(5);
    expect(r.details.taskTypes).toBe('d=3, b=2');
  });
});

describe('createLlmCallInTransactionCheck', () => {
  let alerts: OperatorAlert[];
  const alert = vi.fn(async (a: OperatorAlert) => {
    alerts.push(a);
  });
  beforeEach(() => {
    alerts = [];
    alert.mockClear();
  });

  it('pages on the first read after boot when the counter already moved, then only on a further increase', async () => {
    let current = counts({ estimate_suggest: 1 });
    const check = createLlmCallInTransactionCheck({ alert, logger: noopLogger, readCounts: async () => current });

    await check();
    expect(alerts.map((a) => a.rule)).toEqual([LLM_CALL_IN_TRANSACTION_RULE]);

    await check(); // unchanged
    expect(alerts).toHaveLength(1);

    current = counts({ estimate_suggest: 3 });
    await check();
    expect(alerts).toHaveLength(2);
    expect(alerts[1].details).toMatchObject({ increase: 2 });
  });

  it('a quiet counter never pages', async () => {
    const check = createLlmCallInTransactionCheck({ alert, logger: noopLogger, readCounts: async () => counts({}) });
    await check();
    await check();
    expect(alert).not.toHaveBeenCalled();
  });

  it('never throws: a failed read is logged and the next read still compares against the last good one', async () => {
    const error = vi.fn();
    const reads = [counts({ x: 1 }), new Error('prom read failed'), counts({ x: 1 })];
    const check = createLlmCallInTransactionCheck({
      alert,
      logger: { ...noopLogger, error },
      readCounts: async () => {
        const next = reads.shift()!;
        if (next instanceof Error) throw next;
        return next;
      },
    });
    await check();
    await expect(check()).resolves.toBeUndefined();
    await check();
    expect(error).toHaveBeenCalledOnce();
    expect(alerts).toHaveLength(1);
  });

  it('reads the real counter by default and pages through alertOperator as an [SLO:critical] Sentry event', async () => {
    const captureMessage = vi.fn().mockReturnValue('id');
    const sentry = { captureMessage } as unknown as SentryClient;
    const op = createAlertOperator({ sentry, delivery: null, cooldownMs: 60 * 60 * 1000, logger: noopLogger });
    const check = createLlmCallInTransactionCheck({ alert: op, logger: noopLogger });

    await check(); // baseline read of the real counter
    captureMessage.mockClear();
    gatewayLlmCallInTransactionTotal.inc({ task_type: 'suggest_reply' });
    await check();

    expect(captureMessage).toHaveBeenCalledOnce();
    expect(captureMessage.mock.calls[0][0]).toMatch(
      /^\[SLO:critical\] gateway_llm_call_in_transaction: .*suggest_reply=1/,
    );
    expect(captureMessage.mock.calls[0][1]).toBe('error');
  });
});

/**
 * app.ts from the check's TI-02 comment to the WS2 observability baseline (the
 * segment pattern of the WS15 SLO-monitor pin in process-role.test.ts).
 */
const LLM_CHECK_SEGMENT =
  /\/\/ TI-02 follow-up — page on any increase of[\s\S]*?const observabilityIntervalCount = backgroundIntervals\.length;/;

/**
 * What is wrong with app.ts's wiring of the check; empty when it is wired. The
 * check must be built AND run by a `registerInterval(setInterval(...))` before
 * the observability baseline, with no role gate or leader lock. Comment lines
 * are dropped first, so a commented-out registration does not count.
 */
function llmCheckWiringProblems(appSrc: string): string[] {
  const segment = appSrc.match(LLM_CHECK_SEGMENT);
  if (!segment) return ['no TI-02 block before the observability baseline'];
  const code = segment[0].replace(/^\s*\/\/.*$/gm, '');
  const built = code.match(/const (\w+) = createLlmCallInTransactionCheck\(/);
  if (!built) return ['the check is not built before the observability baseline'];
  const problems: string[] = [];
  const runs = new RegExp(
    String.raw`registerInterval\(\s*setInterval\(\s*\(\)\s*=>\s*void\s+${built[1]}\(\)\s*,\s*LLM_CALL_IN_TRANSACTION_CHECK_INTERVAL_MS\s*,?\s*\)\s*,?\s*\)`,
  );
  if (!runs.test(code)) problems.push(`no registerInterval(setInterval(...)) runs ${built[1]}`);
  if (code.includes('shouldRunWorkers')) problems.push('gated on shouldRunWorkers');
  if (code.includes('runAsLeader(')) problems.push('leader-locked');
  return problems;
}

describe('wiring — the check runs in every process role', () => {
  const appSrc = fs.readFileSync(path.resolve(__dirname, '../../src/app.ts'), 'utf-8');
  // The registration statement as it stands, for the negative controls.
  const registration = appSrc.match(
    /registerInterval\(\s*setInterval\(\s*\(\) => void checkLlmCallInTransaction\(\)[^;]*;/,
  );
  const BASELINE = 'const observabilityIntervalCount = backgroundIntervals.length;';

  it('app.ts builds it and runs it from registerInterval(setInterval(...)) with the observability intervals, before the worker-only baseline', () => {
    expect(llmCheckWiringProblems(appSrc)).toEqual([]);
  });

  describe('negative controls — the pin fails when the interval that runs the check goes', () => {
    it('the registration statement is present to mutate', () => {
      expect(registration).not.toBeNull();
    });

    it('removed', () => {
      const mutated = appSrc.replace(registration![0], '');
      expect(llmCheckWiringProblems(mutated)).toEqual(['no registerInterval(setInterval(...)) runs checkLlmCallInTransaction']);
    });

    it('commented out', () => {
      const commented = registration![0]
        .split('\n')
        .map((line) => `// ${line}`)
        .join('\n');
      const mutated = appSrc.replace(registration![0], commented);
      expect(llmCheckWiringProblems(mutated)).toEqual(['no registerInterval(setInterval(...)) runs checkLlmCallInTransaction']);
    });

    it('moved past the observability baseline (it would count as a worker loop)', () => {
      const mutated = appSrc
        .replace(registration![0], '')
        .replace(BASELINE, `${BASELINE}\n  ${registration![0]}`);
      expect(llmCheckWiringProblems(mutated)).toEqual(['no registerInterval(setInterval(...)) runs checkLlmCallInTransaction']);
    });

    it('gated to worker roles', () => {
      const mutated = appSrc.replace(registration![0], `if (shouldRunWorkers) {\n${registration![0]}\n}`);
      expect(llmCheckWiringProblems(mutated)).toEqual(['gated on shouldRunWorkers']);
    });
  });

  it('the runbook documents the rule and its Prometheus form', () => {
    const runbook = fs.readFileSync(path.resolve(__dirname, '../../../../docs/runbooks/slo-alerts.md'), 'utf-8');
    expect(runbook).toContain(`\`${LLM_CALL_IN_TRANSACTION_RULE}\``);
    expect(runbook).toContain('increase(gateway_llm_call_in_transaction_total[10m])) > 0');
  });
});
