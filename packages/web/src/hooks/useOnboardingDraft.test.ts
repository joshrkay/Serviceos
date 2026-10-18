/**
 * useOnboardingDraft — network stubbed at `fetch` only. The real useApiClient
 * runs (global Clerk mock supplies the token), so these assertions cover the
 * exact paths, bodies and headers that reach the wire.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import draftJson from '../components/onboarding/v3/__fixtures__/draft.plumbing-cle.json';
import { useOnboardingDraft } from './useOnboardingDraft';

const BROWSER_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const CREATE = { packId: 'plumbing', businessName: 'Walsh Plumbing' };

interface Call {
  method: string;
  path: string;
  body: unknown;
  authorization: string | undefined;
}

let calls: Call[];
let responses: Array<Response | Error>;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function stubFetch(queue: Array<Response | Error>): void {
  calls = [];
  responses = [...queue];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({
        method: init?.method ?? 'GET',
        path: String(input),
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
        authorization: headers.Authorization,
      });
      const next = responses.shift();
      if (!next) throw new Error(`unexpected fetch ${String(input)}`);
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    }),
  );
}

const withDraft = (patch: Record<string, unknown>) => ({ ...draftJson, ...patch });

describe('useOnboardingDraft', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('loads the existing draft with the owner token and exposes its version', async () => {
    stubFetch([json(200, { draft: draftJson })]);
    const { result } = renderHook(() => useOnboardingDraft(null));

    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(calls).toEqual([
      { method: 'GET', path: '/api/onboarding/draft', body: undefined, authorization: 'Bearer tok-test-default' },
    ]);
    expect(result.current.draft?.businessName).toBe('Walsh Plumbing');
    expect(result.current.version).toBe(1);
    expect(result.current.error).toBeNull();
  });

  it('leaves the draft null without creating one when there is no create input', async () => {
    stubFetch([json(404, { error: 'NOT_FOUND', message: 'OnboardingDraft not found' })]);
    const { result } = renderHook(() => useOnboardingDraft(null));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.draft).toBeNull();
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /api/onboarding/draft']);
  });

  it('creates the draft when none exists and a create input is given, always sending the browser timezone', async () => {
    stubFetch([
      json(404, { error: 'NOT_FOUND', message: 'OnboardingDraft not found' }),
      json(201, { draft: draftJson, created: true }),
    ]);
    const { result } = renderHook(() => useOnboardingDraft(CREATE));
    await waitFor(() => expect(result.current.draft).not.toBeNull());

    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /api/onboarding/draft', 'POST /api/onboarding/draft']);
    expect(calls[1].body).toEqual({ ...CREATE, clientTimezone: BROWSER_TZ });
  });

  it('does not create when a draft already exists, even with a create input', async () => {
    stubFetch([json(200, { draft: draftJson })]);
    const { result } = renderHook(() => useOnboardingDraft(CREATE));
    await waitFor(() => expect(result.current.draft).not.toBeNull());
    expect(calls).toHaveLength(1);
  });

  it('stages a choice with the version it last saw and adopts the returned draft', async () => {
    stubFetch([
      json(200, { draft: draftJson }),
      json(200, { draft: withDraft({ version: 2, choices: { greeting: { option: 'b' } } }) }),
    ]);
    const { result } = renderHook(() => useOnboardingDraft(null));
    await waitFor(() => expect(result.current.draft).not.toBeNull());

    let ok = false;
    await act(async () => {
      ok = await result.current.stage('greeting', { option: 'b' });
    });

    expect(ok).toBe(true);
    expect(calls[1]).toMatchObject({
      method: 'PUT',
      path: '/api/onboarding/draft/choices/greeting',
      body: { choice: { option: 'b' }, version: 1 },
    });
    expect(result.current.version).toBe(2);
    expect(result.current.draft?.choices.greeting).toEqual({ option: 'b' });
    expect(result.current.notice).toBeNull();
  });

  it('on a 409 VERSION_CONFLICT re-reads the draft, shows a one-line notice, and uses the new version next time', async () => {
    stubFetch([
      json(200, { draft: draftJson }),
      json(409, { error: 'CONFLICT', message: 'VERSION_CONFLICT: expected 1, found 3; re-read the draft' }),
      json(200, { draft: withDraft({ version: 3, choices: { booking_posture: { option: 'b' } } }) }),
      json(200, { draft: withDraft({ version: 4, choices: { booking_posture: { option: 'b' }, greeting: { option: 'b' } } }) }),
    ]);
    const { result } = renderHook(() => useOnboardingDraft(null));
    await waitFor(() => expect(result.current.draft).not.toBeNull());

    let ok = true;
    await act(async () => {
      ok = await result.current.stage('greeting', { option: 'b' });
    });

    expect(ok).toBe(false);
    expect(calls.map((c) => `${c.method} ${c.path}`).slice(1)).toEqual([
      'PUT /api/onboarding/draft/choices/greeting',
      'GET /api/onboarding/draft',
    ]);
    expect(result.current.version).toBe(3);
    expect(result.current.draft?.choices.booking_posture).toEqual({ option: 'b' });
    expect(result.current.notice).toMatch(/\S/);
    expect(result.current.notice).not.toMatch(/\n/);
    expect(result.current.error).toBeNull();

    await act(async () => {
      ok = await result.current.stage('greeting', { option: 'b' });
    });
    expect(ok).toBe(true);
    expect(calls[3].body).toEqual({ choice: { option: 'b' }, version: 3 });
    expect(result.current.notice).toBeNull();
  });

  it('surfaces other staging failures as an error and keeps the draft', async () => {
    stubFetch([json(200, { draft: draftJson }), json(500, { error: 'INTERNAL', message: 'boom' })]);
    const { result } = renderHook(() => useOnboardingDraft(null));
    await waitFor(() => expect(result.current.draft).not.toBeNull());

    let ok = true;
    await act(async () => {
      ok = await result.current.stage('greeting', { option: 'a' });
    });
    expect(ok).toBe(false);
    expect(result.current.error).toMatch(/\S/);
    expect(result.current.draft?.version).toBe(1);
  });

  it('approves with POST /approve and returns the two proposal ids', async () => {
    const approved = withDraft({ status: 'approved', version: 2, proposalIds: ['p1', 'p2'], approvedAt: '2026-10-18T10:05:00.000Z' });
    stubFetch([json(200, { draft: draftJson }), json(200, { draft: approved, proposalIds: ['p1', 'p2'], approvedNow: true })]);
    const { result } = renderHook(() => useOnboardingDraft(null));
    await waitFor(() => expect(result.current.draft).not.toBeNull());

    let res: Awaited<ReturnType<typeof result.current.approve>> = null;
    await act(async () => {
      res = await result.current.approve();
    });

    expect(calls[1]).toMatchObject({ method: 'POST', path: '/api/onboarding/draft/approve' });
    expect(res).toMatchObject({ proposalIds: ['p1', 'p2'], approvedNow: true });
    expect(result.current.draft?.status).toBe('approved');
    expect(result.current.approving).toBe(false);
  });

  it('on a 409 from approve re-reads the draft and reports a plain save error, not a refresh notice', async () => {
    stubFetch([
      json(200, { draft: draftJson }),
      json(409, { error: 'CONFLICT', message: 'DRAFT_APPROVAL_FAILED: p1: stale' }),
      json(200, { draft: withDraft({ version: 5 }) }),
    ]);
    const { result } = renderHook(() => useOnboardingDraft(null));
    await waitFor(() => expect(result.current.draft).not.toBeNull());

    let res: Awaited<ReturnType<typeof result.current.approve>> = null;
    await act(async () => {
      res = await result.current.approve();
    });
    expect(res).toBeNull();
    expect(result.current.version).toBe(5);
    expect(result.current.error).toMatch(/\S/);
    expect(result.current.notice).toBeNull();
  });

  it('reports a load failure and retries on reload', async () => {
    stubFetch([new Error('network down'), json(200, { draft: draftJson })]);
    const { result } = renderHook(() => useOnboardingDraft(null));
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.loading).toBe(false);

    await act(async () => {
      await result.current.reload();
    });
    expect(result.current.error).toBeNull();
    expect(result.current.draft?.version).toBe(1);
  });
});
