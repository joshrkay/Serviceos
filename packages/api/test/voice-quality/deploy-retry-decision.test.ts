/**
 * #1631 — unit tests for the pure decision logic backing
 * `.github/workflows/deploy-retry.yml`. See
 * `.github/scripts/deploy-retry-decision.ts` for the full contract.
 */
import { describe, it, expect } from 'vitest';
import { shouldRetryDeploy, buildRetryComment, run } from '../../../../.github/scripts/deploy-retry-decision';

describe('#1631 — shouldRetryDeploy', () => {
  it('retries when a job was cancelled, no job failed, and the run is on attempt 1', () => {
    const decision = shouldRetryDeploy({
      jobs: [
        { name: 'test', conclusion: 'success' },
        { name: 'deploy-railway-prod', conclusion: 'cancelled' },
      ],
      runAttempt: 1,
      runSha: 'aaa111',
      mainSha: 'aaa111',
    });

    expect(decision).toBe(true);
  });

  it('does NOT retry when any job genuinely failed, even if another was cancelled', () => {
    const decision = shouldRetryDeploy({
      jobs: [
        { name: 'test', conclusion: 'failure' },
        { name: 'deploy-railway-prod', conclusion: 'cancelled' },
      ],
      runAttempt: 1,
      runSha: 'aaa111',
      mainSha: 'aaa111',
    });

    expect(decision).toBe(false);
  });

  it('does NOT retry when nothing was cancelled (plain success)', () => {
    const decision = shouldRetryDeploy({
      jobs: [{ name: 'test', conclusion: 'success' }],
      runAttempt: 1,
      runSha: 'aaa111',
      mainSha: 'aaa111',
    });

    expect(decision).toBe(false);
  });

  it('caps at 2 automatic retries: does NOT retry once the run has already reached attempt 3', () => {
    const decision = shouldRetryDeploy({
      jobs: [{ name: 'deploy-railway-prod', conclusion: 'cancelled' }],
      runAttempt: 3,
      runSha: 'aaa111',
      mainSha: 'aaa111',
    });

    expect(decision).toBe(false);
  });

  it('still retries on attempt 2 (the second and last automatic retry)', () => {
    const decision = shouldRetryDeploy({
      jobs: [{ name: 'deploy-railway-prod', conclusion: 'cancelled' }],
      runAttempt: 2,
      runSha: 'aaa111',
      mainSha: 'aaa111',
    });

    expect(decision).toBe(true);
  });
});

describe('#1631 review — never redeploy a stale commit over a newer one', () => {
  it('does NOT retry when main has moved past the cancelled run commit', () => {
    const decision = shouldRetryDeploy({
      jobs: [{ name: 'deploy-railway-prod', conclusion: 'cancelled' }],
      runAttempt: 1,
      runSha: 'aaa111',
      mainSha: 'bbb222',
    });

    expect(decision).toBe(false);
  });
});

describe('#1631 — buildRetryComment', () => {
  it('includes the run URL and the attempt transition', () => {
    const comment = buildRetryComment({
      runUrl: 'https://github.com/joshrkay/Serviceos/actions/runs/999',
      runAttempt: 1,
      runSha: 'aaa111',
      mainSha: 'aaa111',
    });

    expect(comment).toContain('https://github.com/joshrkay/Serviceos/actions/runs/999');
    expect(comment).toContain('Attempt 1');
    expect(comment).toContain('2');
  });
});

describe('#1631 — run (CLI entry point)', () => {
  function collect() {
    const logs: string[] = [];
    const errors: string[] = [];
    return {
      logs,
      errors,
      log: (msg: string) => logs.push(msg),
      error: (msg: string) => errors.push(msg),
    };
  }

  it('exits 1 with a clear stderr message when required env is missing', () => {
    const { log, error, errors } = collect();

    const code = run({ env: {}, log, error });

    expect(code).toBe(1);
    expect(errors.join('\n')).toMatch(/JOBS_JSON/);
    expect(errors.join('\n')).toMatch(/RUN_ATTEMPT/);
    expect(errors.join('\n')).toMatch(/RUN_SHA/);
    expect(errors.join('\n')).toMatch(/MAIN_SHA/);
  });

  it('exits 1 when JOBS_JSON is not valid JSON', () => {
    const { log, error, errors } = collect();

    const code = run({
      env: { JOBS_JSON: 'not-json', RUN_ATTEMPT: '1', RUN_URL: 'https://x/runs/1', RUN_SHA: 'a', MAIN_SHA: 'a' },
      log,
      error,
    });

    expect(code).toBe(1);
    expect(errors.join('\n')).toMatch(/JOBS_JSON/);
  });

  it('exits 1 when RUN_ATTEMPT is not a positive integer', () => {
    const { log, error, errors } = collect();

    const code = run({
      env: { JOBS_JSON: '[]', RUN_ATTEMPT: 'nope', RUN_URL: 'https://x/runs/1', RUN_SHA: 'a', MAIN_SHA: 'a' },
      log,
      error,
    });

    expect(code).toBe(1);
    expect(errors.join('\n')).toMatch(/RUN_ATTEMPT/);
  });

  it('prints {"retry":true,...} with a comment when the cancelled-only rule matches', () => {
    const { log, logs, error } = collect();

    const code = run({
      env: {
        JOBS_JSON: JSON.stringify([{ name: 'deploy-railway-prod', conclusion: 'cancelled' }]),
        RUN_ATTEMPT: '1',
        RUN_SHA: 'a',
        MAIN_SHA: 'a',
        RUN_URL: 'https://github.com/joshrkay/Serviceos/actions/runs/555',
      },
      log,
      error,
    });

    expect(code).toBe(0);
    const parsed = JSON.parse(logs[0]) as { retry: boolean; comment: string };
    expect(parsed.retry).toBe(true);
    expect(parsed.comment).toContain('https://github.com/joshrkay/Serviceos/actions/runs/555');
  });

  it('prints {"retry":false,"comment":""} when a real failure is present', () => {
    const { log, logs, error } = collect();

    const code = run({
      env: {
        JOBS_JSON: JSON.stringify([{ name: 'test', conclusion: 'failure' }]),
        RUN_ATTEMPT: '1',
        RUN_SHA: 'a',
        MAIN_SHA: 'a',
        RUN_URL: 'https://github.com/joshrkay/Serviceos/actions/runs/555',
      },
      log,
      error,
    });

    expect(code).toBe(0);
    expect(JSON.parse(logs[0])).toEqual({ retry: false, comment: '' });
  });

  it('prints retry:false when main has advanced past the run commit (stale deploy guard)', () => {
    const { log, logs, error } = collect();

    const code = run({
      env: {
        JOBS_JSON: JSON.stringify([{ name: 'deploy-railway-prod', conclusion: 'cancelled' }]),
        RUN_ATTEMPT: '1',
        RUN_SHA: 'aaa111',
        MAIN_SHA: 'bbb222',
        RUN_URL: 'https://github.com/joshrkay/Serviceos/actions/runs/555',
      },
      log,
      error,
    });

    expect(code).toBe(0);
    expect(JSON.parse(logs[0])).toEqual({ retry: false, comment: '' });
  });
});
