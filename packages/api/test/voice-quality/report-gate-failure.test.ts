/**
 * Plan 2026-09-05-001 U2 (R3) — a red scheduled gate must be visible
 * without Slack.
 *
 * Pins the contract for `.github/scripts/report-gate-failure.ts`, the
 * `if: always()` post-step every scheduled gate ends with:
 *
 *   - failure, no open `gate-red` issue for this gate → one is created
 *     with the run URL and the `gate-red` label.
 *   - failure, open issue exists → a comment with the run URL is
 *     appended; no duplicate issue.
 *   - success, open issue exists → a comment is posted and the issue
 *     is closed (PATCH state=closed).
 *   - success, no open issue → no write at all (only the list GET).
 *   - GitHub API non-2xx (403) → exit code 1 and a clear message on
 *     stderr; the workflow's own conclusion is left to stand.
 *   - issue create 422 (label missing) → label created lazily, create
 *     retried once.
 *   - `cancelled` → no write, exit 0 (a cancelled run is neither red
 *     nor green).
 *   - missing required env → exit 1 with the missing name (a
 *     misconfigured reporter must be red, not silently a no-op).
 *
 * The test lives under packages/api/test because vitest only discovers
 * `test/**\/*.test.ts` there; it imports the script directly and stubs
 * the GLOBAL fetch (the script is dependency-free and uses global fetch
 * on Node 20) so the tests stay hermetic.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  GATE_RED_LABEL,
  gateIssueTitle,
  run,
} from '../../../../.github/scripts/report-gate-failure';

interface Call {
  method: string;
  url: string;
  body?: Record<string, unknown>;
}

const RUN_URL = 'https://github.com/joshrkay/Serviceos/actions/runs/123';
const GATE = 'QA Matrix Gate';

function baseEnv(jobStatus: string): NodeJS.ProcessEnv {
  return {
    GITHUB_TOKEN: 'ghs_test',
    GITHUB_REPOSITORY: 'joshrkay/Serviceos',
    GATE_NAME: GATE,
    JOB_STATUS: jobStatus,
    RUN_URL,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText: status === 200 ? 'OK' : status === 201 ? 'Created' : 'Error',
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Installs a fake global fetch. `handlers` is consulted in order; the
 * first whose (method, url) matches answers. Every call is recorded in
 * the returned `calls` array with its parsed JSON body.
 */
function stubFetch(
  handlers: Array<{
    method: string;
    urlIncludes: string;
    respond: (call: Call) => Response;
  }>,
): Call[] {
  const calls: Call[] = [];
  const fake = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = (init?.method ?? 'GET').toUpperCase();
    const call: Call = { method, url };
    if (typeof init?.body === 'string') {
      call.body = JSON.parse(init.body) as Record<string, unknown>;
    }
    calls.push(call);
    const handler = handlers.find(
      (h) => h.method === method && url.includes(h.urlIncludes),
    );
    if (!handler) {
      throw new Error(`unexpected fetch ${method} ${url}`);
    }
    return handler.respond(call);
  });
  vi.stubGlobal('fetch', fake);
  return calls;
}

const OPEN_ISSUE = {
  number: 42,
  title: gateIssueTitle(GATE),
  state: 'open',
  labels: [{ name: GATE_RED_LABEL }],
};

describe('U2 — report-gate-failure', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    errorSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('title is derived from the gate name with the gate-red prefix', () => {
    expect(GATE_RED_LABEL).toBe('gate-red');
    expect(gateIssueTitle('Voice smoke (real call, daily)')).toBe(
      'gate-red: Voice smoke (real call, daily)',
    );
  });

  it('failure with no open issue → creates one with the run URL and label', async () => {
    const calls = stubFetch([
      { method: 'GET', urlIncludes: '/issues?', respond: () => jsonResponse(200, []) },
      {
        method: 'POST',
        urlIncludes: '/issues',
        respond: () => jsonResponse(201, { number: 77, html_url: 'https://x/77' }),
      },
    ]);

    const code = await run({ env: baseEnv('failure') });

    expect(code).toBe(0);
    const list = calls[0];
    expect(list.method).toBe('GET');
    expect(list.url).toContain('/repos/joshrkay/Serviceos/issues?');
    expect(list.url).toContain('state=open');
    expect(list.url).toContain(`labels=${GATE_RED_LABEL}`);

    const creates = calls.filter((c) => c.method === 'POST');
    expect(creates).toHaveLength(1);
    expect(creates[0].url).toMatch(/\/repos\/joshrkay\/Serviceos\/issues$/);
    expect(creates[0].body).toMatchObject({
      title: gateIssueTitle(GATE),
      labels: [GATE_RED_LABEL],
    });
    expect(String(creates[0].body!.body)).toContain(RUN_URL);
    expect(String(creates[0].body!.body)).toContain(GATE);
  });

  it('failure with an open issue → comments with the run URL, no duplicate issue', async () => {
    const calls = stubFetch([
      {
        method: 'GET',
        urlIncludes: '/issues?',
        respond: () => jsonResponse(200, [OPEN_ISSUE]),
      },
      {
        method: 'POST',
        urlIncludes: '/issues/42/comments',
        respond: () => jsonResponse(201, { id: 1 }),
      },
    ]);

    const code = await run({ env: baseEnv('failure') });

    expect(code).toBe(0);
    const writes = calls.filter((c) => c.method !== 'GET');
    expect(writes).toHaveLength(1);
    expect(writes[0].method).toBe('POST');
    expect(writes[0].url).toMatch(/\/issues\/42\/comments$/);
    expect(String(writes[0].body!.body)).toContain(RUN_URL);
  });

  it('failure ignores an open gate-red issue for a DIFFERENT gate', async () => {
    const calls = stubFetch([
      {
        method: 'GET',
        urlIncludes: '/issues?',
        respond: () =>
          jsonResponse(200, [
            { ...OPEN_ISSUE, number: 9, title: gateIssueTitle('Other gate') },
          ]),
      },
      { method: 'POST', urlIncludes: '/issues', respond: () => jsonResponse(201, { number: 78 }) },
    ]);

    const code = await run({ env: baseEnv('failure') });

    expect(code).toBe(0);
    const writes = calls.filter((c) => c.method !== 'GET');
    expect(writes).toHaveLength(1);
    expect(writes[0].url).toMatch(/\/issues$/);
    expect(writes[0].body).toMatchObject({ title: gateIssueTitle(GATE) });
  });

  it('success with an open issue → comments then closes it', async () => {
    const calls = stubFetch([
      {
        method: 'GET',
        urlIncludes: '/issues?',
        respond: () => jsonResponse(200, [OPEN_ISSUE]),
      },
      {
        method: 'POST',
        urlIncludes: '/issues/42/comments',
        respond: () => jsonResponse(201, { id: 2 }),
      },
      {
        method: 'PATCH',
        urlIncludes: '/issues/42',
        respond: () => jsonResponse(200, { number: 42, state: 'closed' }),
      },
    ]);

    const code = await run({ env: baseEnv('success') });

    expect(code).toBe(0);
    const writes = calls.filter((c) => c.method !== 'GET');
    expect(writes.map((c) => c.method)).toEqual(['POST', 'PATCH']);
    expect(String(writes[0].body!.body)).toContain(RUN_URL);
    expect(writes[1].url).toMatch(/\/issues\/42$/);
    expect(writes[1].body).toMatchObject({ state: 'closed' });
  });

  it('success with no open issue → no API write', async () => {
    const calls = stubFetch([
      { method: 'GET', urlIncludes: '/issues?', respond: () => jsonResponse(200, []) },
    ]);

    const code = await run({ env: baseEnv('success') });

    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('GET');
  });

  it('cancelled → no API call at all, exit 0', async () => {
    const calls = stubFetch([]);

    const code = await run({ env: baseEnv('cancelled') });

    expect(code).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('GitHub 403 → exit 1 with a clear message naming the request', async () => {
    stubFetch([
      {
        method: 'GET',
        urlIncludes: '/issues?',
        respond: () =>
          new Response('{"message":"Resource not accessible by integration"}', {
            status: 403,
            statusText: 'Forbidden',
          }),
      },
    ]);

    const code = await run({ env: baseEnv('failure') });

    expect(code).toBe(1);
    expect(errorSpy).toHaveBeenCalled();
    const msg = String(errorSpy.mock.calls[0][0]);
    expect(msg).toContain('[report-gate-failure]');
    expect(msg).toContain('403');
    expect(msg).toContain('GET');
    expect(msg).toContain('/issues');
  });

  it('403 on the write (not the list) also exits 1', async () => {
    stubFetch([
      { method: 'GET', urlIncludes: '/issues?', respond: () => jsonResponse(200, []) },
      {
        method: 'POST',
        urlIncludes: '/issues',
        respond: () => new Response('{}', { status: 403, statusText: 'Forbidden' }),
      },
    ]);

    const code = await run({ env: baseEnv('failure') });

    expect(code).toBe(1);
    expect(String(errorSpy.mock.calls[0][0])).toContain('403');
  });

  it('issue create 422 (missing label) → creates the label lazily and retries once', async () => {
    let createAttempts = 0;
    const calls = stubFetch([
      { method: 'GET', urlIncludes: '/issues?', respond: () => jsonResponse(200, []) },
      {
        method: 'POST',
        urlIncludes: '/labels',
        respond: () => jsonResponse(201, { name: GATE_RED_LABEL }),
      },
      {
        method: 'POST',
        urlIncludes: '/issues',
        respond: () => {
          createAttempts += 1;
          return createAttempts === 1
            ? new Response('{"message":"Validation Failed"}', {
                status: 422,
                statusText: 'Unprocessable Entity',
              })
            : jsonResponse(201, { number: 79 });
        },
      },
    ]);

    const code = await run({ env: baseEnv('failure') });

    expect(code).toBe(0);
    const writes = calls.filter((c) => c.method !== 'GET');
    expect(writes.map((c) => `${c.method} ${c.url.split('/repos/joshrkay/Serviceos')[1]}`)).toEqual([
      'POST /issues',
      'POST /labels',
      'POST /issues',
    ]);
    expect(writes[1].body).toMatchObject({ name: GATE_RED_LABEL });
  });

  it('issue create 422 twice → exit 1 (no infinite retry)', async () => {
    let createAttempts = 0;
    stubFetch([
      { method: 'GET', urlIncludes: '/issues?', respond: () => jsonResponse(200, []) },
      { method: 'POST', urlIncludes: '/labels', respond: () => jsonResponse(201, {}) },
      {
        method: 'POST',
        urlIncludes: '/issues',
        respond: () => {
          createAttempts += 1;
          return new Response('{}', { status: 422, statusText: 'Unprocessable Entity' });
        },
      },
    ]);

    const code = await run({ env: baseEnv('failure') });

    expect(code).toBe(1);
    expect(createAttempts).toBe(2);
    expect(String(errorSpy.mock.calls[0][0])).toContain('422');
  });

  it('missing required env → exit 1 naming the variable, no fetch', async () => {
    const calls = stubFetch([]);
    const env = baseEnv('failure');
    delete env.RUN_URL;

    const code = await run({ env });

    expect(code).toBe(1);
    expect(calls).toHaveLength(0);
    expect(String(errorSpy.mock.calls[0][0])).toContain('RUN_URL');
  });

  it('unknown JOB_STATUS → exit 1, no fetch', async () => {
    const calls = stubFetch([]);

    const code = await run({ env: baseEnv('bogus') });

    expect(code).toBe(1);
    expect(calls).toHaveLength(0);
    expect(String(errorSpy.mock.calls[0][0])).toContain('JOB_STATUS');
  });
});
