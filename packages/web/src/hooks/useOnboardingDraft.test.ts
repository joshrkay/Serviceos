/**
 * useOnboardingDraft — network stubbed at `fetch` only. The real useApiClient
 * runs (global Clerk mock supplies the token), so these assertions cover the
 * exact paths, bodies and headers that reach the wire.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import draftJson from '../components/onboarding/v3/__fixtures__/draft.plumbing-cle.json';
import columbusJson from '../components/onboarding/v3/__fixtures__/draft.plumbing-cmh.json';
import { useOnboardingDraft } from './useOnboardingDraft';

const BROWSER_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const CREATE = { packId: 'plumbing', businessName: 'Walsh Plumbing' };
const TIMEZONE_ERROR = "I couldn't save your time zone. Check your connection and tap again.";

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

  describe('when creating the draft is refused', () => {
    const REASON = 'That does not look like a US cell number. Include the 10-digit area code, for example (216) 555-0100.';
    const refusedPhone = () =>
      json(400, { error: 'VALIDATION_ERROR', message: 'Validation failed', details: { issues: [{ path: 'phone', message: REASON }] } });
    const withCell = (phone: string) => ({ ...CREATE, phone });
    const notFound = () => json(404, { error: 'NOT_FOUND', message: 'OnboardingDraft not found' });

    it('hands back the API\'s reason for the cell as cellProblem, not as a load error the owner can only retry', async () => {
      stubFetch([notFound(), refusedPhone()]);
      const { result } = renderHook(() => useOnboardingDraft(withCell('+44 7911 123456')));
      await waitFor(() => expect(result.current.loading).toBe(false));

      expect(result.current.cellProblem).toBe(REASON);
      expect(result.current.error).toBeNull();
      expect(result.current.draft).toBeNull();
      expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /api/onboarding/draft', 'POST /api/onboarding/draft']);
    });

    it('creates the draft with the corrected cell, and the reason is gone', async () => {
      stubFetch([notFound(), refusedPhone()]);
      const { result, rerender } = renderHook(({ input }) => useOnboardingDraft(input), {
        initialProps: { input: withCell('+44 7911 123456') },
      });
      await waitFor(() => expect(result.current.cellProblem).toBe(REASON));

      responses.push(notFound(), json(201, { draft: draftJson, created: true }));
      rerender({ input: withCell('(216) 555-0142') });
      await waitFor(() => expect(result.current.draft).not.toBeNull());

      expect(calls[3]).toMatchObject({ method: 'POST', body: { ...CREATE, phone: '(216) 555-0142', clientTimezone: BROWSER_TZ } });
      expect(result.current.cellProblem).toBeNull();
      expect(result.current.error).toBeNull();
    });

    it('keeps every other create failure a load error, with no reason for the cell', async () => {
      for (const refusal of [
        json(400, { error: 'VALIDATION_ERROR', message: 'Validation failed', details: { issues: [{ path: 'businessName', message: 'Too big' }] } }),
        json(400, { error: 'VALIDATION_ERROR', message: 'Invalid request data', details: { fields: { phone: ['Too small'] } } }),
        json(500, { error: 'INTERNAL', message: 'boom' }),
        new Error('network down'),
      ]) {
        stubFetch([notFound(), refusal]);
        const { result } = renderHook(() => useOnboardingDraft(withCell('(216) 555-0142')));
        await waitFor(() => expect(result.current.loading).toBe(false));
        expect(result.current.error).toMatch(/couldn't load your setup/);
        expect(result.current.cellProblem).toBeNull();
        expect(result.current.draft).toBeNull();
      }
    });

    it('clears the reason when the owner tries again', async () => {
      stubFetch([notFound(), refusedPhone()]);
      const { result } = renderHook(() => useOnboardingDraft(withCell('+44 7911 123456')));
      await waitFor(() => expect(result.current.cellProblem).toBe(REASON));

      responses.push(notFound(), json(201, { draft: draftJson, created: true }));
      await act(async () => {
        await result.current.reload();
      });
      expect(result.current.cellProblem).toBeNull();
      expect(result.current.draft).not.toBeNull();
    });
  });

  it('backfills the timezone on an existing unapproved draft that has none, through the idempotent create route', async () => {
    const zoneless = withDraft({ clientTimezone: null, ownerFirstName: 'Jenna' });
    stubFetch([json(200, { draft: zoneless }), json(200, { draft: withDraft({ clientTimezone: BROWSER_TZ, version: 2 }), created: false })]);
    const { result } = renderHook(() => useOnboardingDraft(null));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /api/onboarding/draft', 'POST /api/onboarding/draft']);
    expect(calls[1].body).toEqual({ packId: 'plumbing', businessName: 'Walsh Plumbing', ownerFirstName: 'Jenna', clientTimezone: BROWSER_TZ });
    expect(result.current.draft?.clientTimezone).toBe(BROWSER_TZ);
    expect(result.current.version).toBe(2);
    expect(result.current.error).toBeNull();
  });

  it('keeps showing a zoneless draft when the backfill call fails, and never backfills an approved one', async () => {
    stubFetch([json(200, { draft: withDraft({ clientTimezone: null }) }), new Error('network down')]);
    const { result } = renderHook(() => useOnboardingDraft(null));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(calls).toHaveLength(2);
    expect(result.current.draft?.clientTimezone).toBeNull();
    expect(result.current.error).toBeNull();

    stubFetch([json(200, { draft: withDraft({ clientTimezone: null, status: 'approved', proposalIds: ['p1', 'p2'] }) })]);
    const approved = renderHook(() => useOnboardingDraft(null));
    await waitFor(() => expect(approved.result.current.loading).toBe(false));
    expect(calls.map((c) => c.method)).toEqual(['GET']);
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

  it('on a 409 DRAFT_APPROVED while staging, re-reads the draft so the shell can move on, with no error line', async () => {
    const approved = withDraft({ status: 'approved', version: 3, proposalIds: ['p1', 'p2'], approvedAt: '2026-10-18T10:05:00.000Z' });
    stubFetch([
      json(200, { draft: draftJson }),
      json(409, { error: 'CONFLICT', message: 'DRAFT_APPROVED: the draft is already approved' }),
      json(200, { draft: approved }),
    ]);
    const { result } = renderHook(() => useOnboardingDraft(null));
    await waitFor(() => expect(result.current.draft).not.toBeNull());

    let staged = true;
    await act(async () => {
      staged = await result.current.stage('greeting', { option: 'b' });
    });
    expect(staged).toBe(false);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /api/onboarding/draft',
      'PUT /api/onboarding/draft/choices/greeting',
      'GET /api/onboarding/draft',
    ]);
    expect(result.current.draft?.status).toBe('approved');
    expect(result.current.error).toBeNull();
    expect(result.current.notice).toBeNull();
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

    // The version of the read-back the owner is looking at rides along, so a stale tab cannot approve it.
    expect(calls[1]).toMatchObject({ method: 'POST', path: '/api/onboarding/draft/approve', body: { expectedVersion: 1 } });
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

  it('approves from the version a queued staging write returned, not the one the tap saw', async () => {
    const staged = withDraft({ version: 2, choices: { greeting: { option: 'b' } } });
    const approved = withDraft({ status: 'approved', version: 2, proposalIds: ['p1', 'p2'], approvedAt: '2026-10-18T10:05:00.000Z' });
    stubFetch([
      json(200, { draft: draftJson }),
      json(200, { draft: staged }),
      json(200, { draft: approved, proposalIds: ['p1', 'p2'], approvedNow: true }),
    ]);
    const { result } = renderHook(() => useOnboardingDraft(null));
    await waitFor(() => expect(result.current.draft).not.toBeNull());

    await act(async () => {
      const staging = result.current.stage('greeting', { option: 'b' });
      const approving = result.current.approve();
      await Promise.all([staging, approving]);
    });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /api/onboarding/draft',
      'PUT /api/onboarding/draft/choices/greeting',
      'POST /api/onboarding/draft/approve',
    ]);
    expect(calls[2].body).toEqual({ expectedVersion: 2 });
  });

  it('on a 409 VERSION_CONFLICT from approve (a stale tab) re-reads the draft and shows the refresh notice, not an error', async () => {
    stubFetch([
      json(200, { draft: draftJson }),
      json(409, { error: 'CONFLICT', message: 'VERSION_CONFLICT: expected 1, found 3; re-read the draft' }),
      json(200, { draft: withDraft({ version: 3 }) }),
    ]);
    const { result } = renderHook(() => useOnboardingDraft(null));
    await waitFor(() => expect(result.current.draft).not.toBeNull());

    let res: Awaited<ReturnType<typeof result.current.approve>> = null;
    await act(async () => {
      res = await result.current.approve();
    });
    expect(res).toBeNull();
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /api/onboarding/draft',
      'POST /api/onboarding/draft/approve',
      'GET /api/onboarding/draft',
    ]);
    expect(result.current.version).toBe(3);
    expect(result.current.notice).toMatch(/changed somewhere else/);
    expect(result.current.error).toBeNull();
    expect(result.current.approving).toBe(false);
  });

  it('on a VERSION_CONFLICT whose re-read says the draft is already approved, shows nothing and the draft is approved', async () => {
    const approved = withDraft({ status: 'approved', version: 3, proposalIds: ['p1', 'p2'], approvedAt: '2026-10-18T10:05:00.000Z' });
    stubFetch([
      json(200, { draft: draftJson }),
      json(409, { error: 'CONFLICT', message: 'VERSION_CONFLICT: expected 1, found 3; re-read the draft' }),
      json(200, { draft: approved }),
    ]);
    const { result } = renderHook(() => useOnboardingDraft(null));
    await waitFor(() => expect(result.current.draft).not.toBeNull());

    await act(async () => {
      await result.current.approve();
    });
    expect(result.current.draft?.status).toBe('approved');
    expect(result.current.error).toBeNull();
    expect(result.current.notice).toBeNull();
  });

  describe('changeMetro', () => {
    it('PUTs /metro with the version it holds and adopts the re-priced draft', async () => {
      stubFetch([json(200, { draft: draftJson }), json(200, { draft: columbusJson })]);
      const { result } = renderHook(() => useOnboardingDraft(null));
      await waitFor(() => expect(result.current.draft).not.toBeNull());

      let saved: unknown = null;
      await act(async () => {
        saved = await result.current.changeMetro('CMH');
      });
      expect(saved).toEqual(columbusJson);
      expect(calls[1]).toMatchObject({ method: 'PUT', path: '/api/onboarding/draft/metro', body: { metro: 'CMH', version: 1 } });
      expect(result.current.draft).toMatchObject({ metroCode: 'CMH', metroName: 'Columbus', version: 2 });
      expect(result.current.notice).toBeNull();
      expect(result.current.error).toBeNull();
    });

    it.each([
      ['DRAFT_METRO_LOCKED (a choice was staged in another window)', 'DRAFT_METRO_LOCKED: a choice is already staged, so the city can no longer change here', withDraft({ version: 2, choices: { greeting: { option: 'b' } } })],
      ['VERSION_CONFLICT', 'VERSION_CONFLICT: expected 1, found 2; re-read the draft', withDraft({ version: 2, clientTimezone: 'America/Chicago' })],
    ])('on a 409 %s re-reads once, says it refreshed, and never repeats the call', async (_n, message, current) => {
      stubFetch([json(200, { draft: draftJson }), json(409, { error: 'CONFLICT', message }), json(200, { draft: current })]);
      const { result } = renderHook(() => useOnboardingDraft(null));
      await waitFor(() => expect(result.current.draft).not.toBeNull());

      let saved: unknown = 'unset';
      await act(async () => {
        saved = await result.current.changeMetro('CMH');
      });
      expect(saved).toBeNull();
      expect(calls.map((c) => `${c.method} ${c.path}`).slice(1)).toEqual(['PUT /api/onboarding/draft/metro', 'GET /api/onboarding/draft']);
      expect(result.current.draft).toEqual(current);
      expect(result.current.notice).toBe('Your answers changed somewhere else, so I refreshed them.');
      expect(result.current.error).toBeNull();
    });

    it('a 409 whose re-read says the draft was approved elsewhere shows nothing: the shell moves on', async () => {
      const approved = withDraft({ version: 2, status: 'approved', proposalIds: ['p1', 'p2'], approvedAt: '2026-10-18T10:05:00.000Z' });
      stubFetch([json(200, { draft: draftJson }), json(409, { error: 'CONFLICT', message: 'DRAFT_APPROVED: the draft is already approved' }), json(200, { draft: approved })]);
      const { result } = renderHook(() => useOnboardingDraft(null));
      await waitFor(() => expect(result.current.draft).not.toBeNull());
      await act(async () => {
        await result.current.changeMetro('CMH');
      });
      expect(result.current.draft?.status).toBe('approved');
      expect(result.current.notice).toBeNull();
      expect(result.current.error).toBeNull();
    });

    it('any other failure is a plain save error and the draft stays as it was', async () => {
      stubFetch([json(200, { draft: draftJson }), json(500, { error: 'INTERNAL', message: 'boom' })]);
      const { result } = renderHook(() => useOnboardingDraft(null));
      await waitFor(() => expect(result.current.draft).not.toBeNull());
      await act(async () => {
        await result.current.changeMetro('CMH');
      });
      expect(calls).toHaveLength(2);
      expect(result.current.draft?.metroCode).toBe('CLE');
      expect(result.current.error).toBe("That didn't go through. Try again.");
    });
  });

  describe('the timezone backfill before approval', () => {
    it('retries a backfill that failed on load before approving, so approval is not refused for a missing zone', async () => {
      const zoneless = withDraft({ clientTimezone: null });
      const zoned = withDraft({ clientTimezone: BROWSER_TZ, version: 2 });
      stubFetch([
        json(200, { draft: zoneless }),
        new Error('network down'),
        json(200, { draft: zoned, created: false }),
        json(200, { draft: { ...zoned, status: 'approved', version: 3, proposalIds: ['p1', 'p2'] }, proposalIds: ['p1', 'p2'], approvedNow: true }),
      ]);
      const { result } = renderHook(() => useOnboardingDraft(null));
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.draft?.clientTimezone).toBeNull();

      await act(async () => {
        await result.current.approve();
      });
      expect(calls.map((c) => `${c.method} ${c.path}`).slice(2)).toEqual(['POST /api/onboarding/draft', 'POST /api/onboarding/draft/approve']);
      expect(calls[2].body).toMatchObject({ packId: 'plumbing', businessName: 'Walsh Plumbing', clientTimezone: BROWSER_TZ });
      // The approve carries the version the backfill returned.
      expect(calls[3].body).toEqual({ expectedVersion: 2 });
      expect(result.current.draft?.status).toBe('approved');
      expect(result.current.error).toBeNull();
    });

    it('when the retry fails too, says so in plain words and does not send an approve the API would refuse', async () => {
      stubFetch([json(200, { draft: withDraft({ clientTimezone: null }) }), new Error('network down'), new Error('still down')]);
      const { result } = renderHook(() => useOnboardingDraft(null));
      await waitFor(() => expect(result.current.loading).toBe(false));
      let res: unknown = 'unset';
      await act(async () => {
        res = await result.current.approve();
      });
      expect(res).toBeNull();
      expect(calls.map((c) => `${c.method} ${c.path}`).slice(2)).toEqual(['POST /api/onboarding/draft']);
      expect(result.current.error).toBe(TIMEZONE_ERROR);
    });

    it('says the same plain words when approve itself is refused for a missing zone, and sends nothing more', async () => {
      stubFetch([
        json(200, { draft: draftJson }),
        json(400, { error: 'VALIDATION_ERROR', message: 'TIMEZONE_REQUIRED: the browser timezone must be recorded on the draft before approval' }),
      ]);
      const { result } = renderHook(() => useOnboardingDraft(null));
      await waitFor(() => expect(result.current.draft).not.toBeNull());
      let res: unknown = 'unset';
      await act(async () => {
        res = await result.current.approve();
      });
      expect(res).toBeNull();
      expect(calls).toHaveLength(2);
      expect(result.current.error).toBe(TIMEZONE_ERROR);
    });
  });

  describe('after approval: undo, retry and start over', () => {
    const IDS = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
    const approvedAt = (version: number) =>
      withDraft({ status: 'approved', version, proposalIds: IDS, approvedAt: '2026-10-18T10:05:00.000Z', choices: { greeting: { option: 'b' } } });
    const editableAt = (version: number) => withDraft({ version, choices: { greeting: { option: 'b' } } });
    const conflict = (message: string) => json(409, { error: 'CONFLICT', message });
    const paths = () => calls.map((c) => `${c.method} ${c.path}`);

    async function holding(draft: object, queue: Array<Response | Error>) {
      stubFetch([json(200, { draft }), ...queue]);
      const hook = renderHook(() => useOnboardingDraft(null));
      await waitFor(() => expect(hook.result.current.draft).not.toBeNull());
      return hook.result;
    }

    it('undo posts the version it holds with the owner token and commits the draft, editable again with nothing listed', async () => {
      const result = await holding(approvedAt(2), [json(200, { draft: editableAt(3) })]);
      let outcome: unknown;
      await act(async () => {
        outcome = await result.current.undo();
      });
      expect(calls[1]).toEqual({ method: 'POST', path: '/api/onboarding/draft/undo', body: { expectedVersion: 2 }, authorization: 'Bearer tok-test-default' });
      expect(outcome).toMatchObject({ kind: 'done' });
      expect(result.current.draft).toMatchObject({ status: 'draft', version: 3, proposalIds: [], choices: { greeting: { option: 'b' } } });
      expect(result.current.error).toBeNull();
      expect(result.current.notice).toBeNull();
    });

    it('start over posts the version it holds and commits the draft with the answers intact', async () => {
      const result = await holding(approvedAt(4), [json(200, { draft: editableAt(5) })]);
      await act(async () => {
        await result.current.reset();
      });
      expect(calls[1]).toEqual({ method: 'POST', path: '/api/onboarding/draft/reset', body: { expectedVersion: 4 }, authorization: 'Bearer tok-test-default' });
      expect(result.current.draft).toMatchObject({ status: 'draft', version: 5, proposalIds: [], choices: { greeting: { option: 'b' } } });
    });

    it('retry posts the version it holds and commits the next one, so the undo after it carries v + 1', async () => {
      const result = await holding(approvedAt(2), [
        json(200, { draft: approvedAt(3), retriedProposalIds: IDS, undoable: true }),
        json(200, { draft: editableAt(4) }),
      ]);
      let outcome: unknown;
      await act(async () => {
        outcome = await result.current.retry();
      });
      expect(calls[1]).toMatchObject({ path: '/api/onboarding/draft/retry', body: { expectedVersion: 2 } });
      expect(outcome).toMatchObject({ kind: 'done', response: { undoable: true, retriedProposalIds: IDS } });
      expect(result.current.version).toBe(3);

      await act(async () => {
        await result.current.undo();
      });
      expect(calls[2]).toMatchObject({ path: '/api/onboarding/draft/undo', body: { expectedVersion: 3 } });
    });

    it('posts a newer version the screen has seen on a status poll (another window retried), never an older one', async () => {
      const result = await holding(approvedAt(2), [json(200, { draft: editableAt(5) }), json(200, { draft: editableAt(6) })]);
      await act(async () => {
        await result.current.reset(4);
      });
      expect(calls[1].body).toEqual({ expectedVersion: 4 });
      await act(async () => {
        await result.current.undo(1);
      });
      expect(calls[2].body).toEqual({ expectedVersion: 5 });
    });

    for (const message of ['VERSION_CONFLICT: expected 2, found 3; re-read the draft', 'DRAFT_NOT_APPROVED: the draft has not been approved']) {
      for (const action of ['undo', 'retry', 'reset'] as const) {
        it(`${action}: a 409 ${message.split(':')[0]} re-reads the draft, says it changed in another window, and does not repeat the call`, async () => {
          const result = await holding(approvedAt(2), [conflict(message), json(200, { draft: editableAt(3) })]);
          let outcome: unknown;
          await act(async () => {
            outcome = await result.current[action]();
          });
          expect(outcome).toEqual({ kind: 'moved' });
          expect(paths()).toEqual(['GET /api/onboarding/draft', `POST /api/onboarding/draft/${action}`, 'GET /api/onboarding/draft']);
          expect(result.current.version).toBe(3);
          expect(result.current.notice).toBe('This changed in another window.');
          expect(result.current.error).toBeNull();
        });
      }
    }

    it('hands a typed refusal back to the screen to decide, without an error line or a re-read', async () => {
      const result = await holding(approvedAt(2), [
        conflict('UNDO_WINDOW_CLOSED: It is too late to undo this.'),
        conflict('DRAFT_UNDO_REFUSED: part of it is being saved right now.'),
        json(409, { error: 'CONFLICT', message: 'DRAFT_RESET_REFUSED: Part of your setup is already saved.', details: { reason: 'applied' } }),
        json(409, { error: 'CONFLICT', message: 'DRAFT_RESET_REFUSED: being saved right now.', details: { reason: 'executing' } }),
        conflict('DRAFT_RETRY_UNSAFE: Retrying could leave your setup half saved.'),
      ]);
      const outcomes: unknown[] = [];
      await act(async () => {
        outcomes.push(await result.current.undo());
        outcomes.push(await result.current.undo());
        outcomes.push(await result.current.reset());
        outcomes.push(await result.current.reset());
        outcomes.push(await result.current.retry());
      });
      expect(outcomes).toEqual([
        { kind: 'refused', refusal: 'UNDO_WINDOW_CLOSED', resetReason: null },
        { kind: 'refused', refusal: 'DRAFT_UNDO_REFUSED', resetReason: null },
        { kind: 'refused', refusal: 'DRAFT_RESET_REFUSED', resetReason: 'applied' },
        { kind: 'refused', refusal: 'DRAFT_RESET_REFUSED', resetReason: 'executing' },
        { kind: 'refused', refusal: 'DRAFT_RETRY_UNSAFE', resetReason: null },
      ]);
      expect(paths().filter((p) => p.startsWith('GET'))).toHaveLength(1);
      expect(result.current.error).toBeNull();
      expect(result.current.notice).toBeNull();
      expect(result.current.draft?.version).toBe(2);
    });

    it('reports a dropped connection or a server failure as failed, with the status to word it by', async () => {
      const result = await holding(approvedAt(2), [new TypeError('network down'), json(500, { error: 'INTERNAL', message: 'boom' })]);
      const outcomes: unknown[] = [];
      await act(async () => {
        outcomes.push(await result.current.retry());
        outcomes.push(await result.current.retry());
      });
      expect(outcomes).toEqual([
        { kind: 'failed', status: null },
        { kind: 'failed', status: 500 },
      ]);
      expect(result.current.draft?.version).toBe(2);
    });

    it('a double tap sends one request, and says which action is in flight while it is', async () => {
      let release: (r: Response) => void = () => undefined;
      stubFetch([json(200, { draft: approvedAt(2) })]);
      const { result } = renderHook(() => useOnboardingDraft(null));
      await waitFor(() => expect(result.current.draft).not.toBeNull());
      vi.mocked(fetch).mockImplementationOnce((input, init) => {
        calls.push({ method: init?.method ?? 'GET', path: String(input), body: JSON.parse(String(init?.body)), authorization: undefined });
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      });
      let first: Promise<unknown> = Promise.resolve();
      let second: Promise<unknown> = Promise.resolve();
      act(() => {
        first = result.current.undo();
        second = result.current.undo();
      });
      await waitFor(() => expect(result.current.recovering).toBe('undo'));
      await act(async () => {
        release(json(200, { draft: editableAt(3) }));
        await Promise.all([first, second]);
      });
      expect(paths().filter((p) => p.endsWith('/undo'))).toHaveLength(1);
      expect(await second).toMatchObject({ kind: 'done' });
      expect(result.current.recovering).toBeNull();
    });
  });

  it('keeps a draft that has gained ownerPhone parseable, and one that predates the field', async () => {
    stubFetch([json(200, { draft: withDraft({ ownerPhone: '+12165550142' }) })]);
    const withPhone = renderHook(() => useOnboardingDraft(null));
    await waitFor(() => expect(withPhone.result.current.draft).not.toBeNull());
    expect(withPhone.result.current.error).toBeNull();
    expect(withPhone.result.current.draft?.ownerPhone).toBe('+12165550142');

    stubFetch([json(200, { draft: draftJson })]);
    const without = renderHook(() => useOnboardingDraft(null));
    await waitFor(() => expect(without.result.current.draft).not.toBeNull());
    expect(without.result.current.draft?.ownerPhone).toBeUndefined();
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
