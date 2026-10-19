import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ONBOARDING_DRAFT_REFUSALS, OnboardingDraftSchema } from '@ai-service-os/shared';
import draftJson from '../components/onboarding/v3/__fixtures__/draft.plumbing-cle.json';
import {
  OnboardingDraftApiError,
  approveDraft,
  createDraft,
  getDraft,
  resetDraft,
  retryDraft,
  setMetro,
  stageChoice,
  undoDraft,
} from './onboardingDraftApi';
import columbusJson from '../components/onboarding/v3/__fixtures__/draft.plumbing-cmh.json';

const draft = OnboardingDraftSchema.parse(draftJson);

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** apiFetch is a plain fetch-shaped function; the network boundary is stubbed one level lower, in the hook test. */
const apiFetch = vi.fn<(path: string, init?: RequestInit) => Promise<Response>>();

describe('onboardingDraftApi', () => {
  beforeEach(() => {
    apiFetch.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('getDraft reads GET /api/onboarding/draft and parses it with the shared schema', async () => {
    apiFetch.mockResolvedValueOnce(json(200, { draft: draftJson }));
    expect(await getDraft(apiFetch)).toEqual(draft);
    expect(apiFetch).toHaveBeenCalledWith('/api/onboarding/draft');
  });

  it('getDraft returns null on 404 (no draft yet) and throws on other failures', async () => {
    apiFetch.mockResolvedValueOnce(json(404, { error: 'NOT_FOUND', message: 'OnboardingDraft not found' }));
    expect(await getDraft(apiFetch)).toBeNull();

    apiFetch.mockResolvedValueOnce(json(500, { error: 'INTERNAL', message: 'boom' }));
    await expect(getDraft(apiFetch)).rejects.toMatchObject({ status: 500 });
  });

  it('createDraft POSTs the body and reports whether the draft was created', async () => {
    apiFetch.mockResolvedValueOnce(json(201, { draft: draftJson, created: true }));
    const body = { packId: 'plumbing', businessName: 'Walsh Plumbing', clientTimezone: 'America/New_York' };
    const res = await createDraft(apiFetch, body);
    expect(res).toEqual({ draft, created: true });
    expect(apiFetch).toHaveBeenCalledWith('/api/onboarding/draft', { method: 'POST', body: JSON.stringify(body) });
  });

  it('stageChoice PUTs the choice with the version the client last saw', async () => {
    apiFetch.mockResolvedValueOnce(json(200, { draft: { ...draftJson, version: 2, choices: { greeting: { option: 'b' } } } }));
    const next = await stageChoice(apiFetch, 'greeting', { option: 'b' }, 1);
    expect(next.version).toBe(2);
    expect(apiFetch).toHaveBeenCalledWith('/api/onboarding/draft/choices/greeting', {
      method: 'PUT',
      body: JSON.stringify({ choice: { option: 'b' }, version: 1 }),
    });
  });

  it('stageChoice flags a VERSION_CONFLICT so callers can re-read', async () => {
    apiFetch.mockResolvedValueOnce(
      json(409, { error: 'CONFLICT', message: 'VERSION_CONFLICT: expected 1, found 3; re-read the draft' }),
    );
    const err = await stageChoice(apiFetch, 'greeting', { option: 'a' }, 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OnboardingDraftApiError);
    expect(err).toMatchObject({ status: 409, versionConflict: true });
  });

  it('setMetro PUTs the metro code with the version the Ready screen rendered and returns the re-priced draft', async () => {
    apiFetch.mockResolvedValueOnce(json(200, { draft: columbusJson }));
    const next = await setMetro(apiFetch, 'CMH', 1);
    expect(next).toMatchObject({ metroCode: 'CMH', metroName: 'Columbus', version: 2 });
    expect(apiFetch).toHaveBeenCalledWith('/api/onboarding/draft/metro', { method: 'PUT', body: JSON.stringify({ metro: 'CMH', version: 1 }) });
  });

  it('setMetro carries DRAFT_METRO_LOCKED and VERSION_CONFLICT apart', async () => {
    apiFetch.mockResolvedValueOnce(json(409, { error: 'CONFLICT', message: 'DRAFT_METRO_LOCKED: a choice is already staged, so the city can no longer change here' }));
    await expect(setMetro(apiFetch, 'CMH', 1)).rejects.toMatchObject({ status: 409, versionConflict: false, refusal: 'DRAFT_METRO_LOCKED' });
    apiFetch.mockResolvedValueOnce(json(409, { error: 'CONFLICT', message: 'VERSION_CONFLICT: expected 1, found 2; re-read the draft' }));
    await expect(setMetro(apiFetch, 'CMH', 1)).rejects.toMatchObject({ status: 409, versionConflict: true, refusal: 'VERSION_CONFLICT' });
  });

  it('approveDraft POSTs /approve and returns both proposal ids', async () => {
    const approved = { ...draftJson, status: 'approved', version: 2, proposalIds: ['p1', 'p2'], approvedAt: '2026-10-18T10:05:00.000Z' };
    apiFetch.mockResolvedValueOnce(json(200, { draft: approved, proposalIds: ['p1', 'p2'], approvedNow: true }));
    const res = await approveDraft(apiFetch);
    expect(res.proposalIds).toEqual(['p1', 'p2']);
    expect(res.approvedNow).toBe(true);
    expect(apiFetch).toHaveBeenCalledWith('/api/onboarding/draft/approve', { method: 'POST', body: '{}' });
  });

  it('approveDraft sends the version the read-back was rendered from, so a stale tab is told apart from a repeat', async () => {
    const approved = { ...draftJson, status: 'approved', version: 4, proposalIds: ['p1', 'p2'], approvedAt: '2026-10-18T10:05:00.000Z' };
    apiFetch.mockResolvedValueOnce(json(200, { draft: approved, proposalIds: ['p1', 'p2'], approvedNow: true }));
    await approveDraft(apiFetch, 3);
    expect(apiFetch).toHaveBeenCalledWith('/api/onboarding/draft/approve', { method: 'POST', body: JSON.stringify({ expectedVersion: 3 }) });
  });

  it('approveDraft flags a VERSION_CONFLICT from a stale expectedVersion', async () => {
    apiFetch.mockResolvedValueOnce(json(409, { error: 'CONFLICT', message: 'VERSION_CONFLICT: expected 1, found 3; re-read the draft' }));
    const err = await approveDraft(apiFetch, 1).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 409, versionConflict: true });
  });

  const approvedJson = { ...draftJson, status: 'approved', version: 2, proposalIds: ['p1', 'p2'], approvedAt: '2026-10-18T10:05:00.000Z' };
  const editableJson = { ...draftJson, version: 3 };

  it('retryDraft POSTs /retry with the version the failed screen holds and returns the re-queued ids and whether Undo can still run', async () => {
    apiFetch.mockResolvedValueOnce(json(200, { draft: { ...approvedJson, version: 3 }, retriedProposalIds: ['p2'], undoable: false }));
    const res = await retryDraft(apiFetch, 2);
    expect(res.retriedProposalIds).toEqual(['p2']);
    expect(res.draft.version).toBe(3);
    expect(res.undoable).toBe(false);
    expect(apiFetch).toHaveBeenCalledWith('/api/onboarding/draft/retry', { method: 'POST', body: JSON.stringify({ expectedVersion: 2 }) });
  });

  it('retryDraft throws the API error for a 409 and for a body that does not match the contract', async () => {
    apiFetch.mockResolvedValueOnce(json(409, { error: 'CONFLICT', message: 'DRAFT_RETRY_NOTHING_FAILED: no proposal is in execution_failed' }));
    await expect(retryDraft(apiFetch, 2)).rejects.toMatchObject({ status: 409, code: 'CONFLICT', versionConflict: false, refusal: 'DRAFT_RETRY_NOTHING_FAILED' });

    apiFetch.mockResolvedValueOnce(json(200, { draft: draftJson }));
    await expect(retryDraft(apiFetch, 2)).rejects.toMatchObject({ code: 'UNEXPECTED_RESPONSE' });
  });

  it('undoDraft POSTs /undo with the version the saving screen holds and returns the draft, editable again', async () => {
    apiFetch.mockResolvedValueOnce(json(200, { draft: editableJson }));
    const res = await undoDraft(apiFetch, 2);
    expect(res.draft).toEqual(OnboardingDraftSchema.parse(editableJson));
    expect(apiFetch).toHaveBeenCalledWith('/api/onboarding/draft/undo', { method: 'POST', body: JSON.stringify({ expectedVersion: 2 }) });

    apiFetch.mockResolvedValueOnce(json(200, { draft: editableJson, extra: true }));
    await expect(undoDraft(apiFetch, 2)).rejects.toMatchObject({ code: 'UNEXPECTED_RESPONSE' });
  });

  it('resetDraft POSTs /reset with the version the stopped screen holds and returns the draft with its answers', async () => {
    const answered = { ...editableJson, choices: { greeting: { option: 'b' } } };
    apiFetch.mockResolvedValueOnce(json(200, { draft: answered }));
    const res = await resetDraft(apiFetch, 4);
    expect(res.draft.choices).toEqual({ greeting: { option: 'b' } });
    expect(apiFetch).toHaveBeenCalledWith('/api/onboarding/draft/reset', { method: 'POST', body: JSON.stringify({ expectedVersion: 4 }) });
  });

  it('names the refusal from the message prefix for every 409 the draft routes answer, and the reason a reset was refused', async () => {
    for (const code of ONBOARDING_DRAFT_REFUSALS) {
      apiFetch.mockResolvedValueOnce(json(409, { error: 'CONFLICT', message: `${code}: in plain words` }));
      const err = (await undoDraft(apiFetch, 2).catch((e: unknown) => e)) as OnboardingDraftApiError;
      expect(err.refusal, code).toBe(code);
      expect(err.resetReason, code).toBeNull();
    }
    for (const reason of ['applied', 'executing'] as const) {
      apiFetch.mockResolvedValueOnce(
        json(409, { error: 'CONFLICT', message: 'DRAFT_RESET_REFUSED: Part of your setup is already saved.', details: { reason, statuses: [] } }),
      );
      const err = (await resetDraft(apiFetch, 2).catch((e: unknown) => e)) as OnboardingDraftApiError;
      expect(err).toMatchObject({ refusal: 'DRAFT_RESET_REFUSED', resetReason: reason });
    }
    // Not a refusal: a code the routes never send, a 409 with no prefix, a prefix on another status.
    for (const [status, message] of [
      [409, 'SOMETHING_ELSE: no'],
      [409, 'HTTP 409'],
      [400, 'VERSION_CONFLICT: not on a 400'],
      [500, 'boom'],
    ] as const) {
      apiFetch.mockResolvedValueOnce(json(status, { error: 'X', message, details: { reason: 'applied' } }));
      const err = (await resetDraft(apiFetch, 2).catch((e: unknown) => e)) as OnboardingDraftApiError;
      expect(err.refusal, message).toBeNull();
      expect(err.resetReason, message).toBeNull();
    }
  });

  it('rejects a response that does not match the shared schema', async () => {
    apiFetch.mockResolvedValueOnce(json(200, { draft: { ...draftJson, version: 'one' } }));
    await expect(getDraft(apiFetch)).rejects.toMatchObject({ code: 'UNEXPECTED_RESPONSE' });
  });

  it('createDraft carries the per-field reasons of a 400, so the form can show the one for the cell', async () => {
    const reason = 'That does not look like a US cell number. Include the 10-digit area code, for example (216) 555-0100.';
    apiFetch.mockResolvedValueOnce(
      json(400, { error: 'VALIDATION_ERROR', message: 'Validation failed', details: { issues: [{ path: 'phone', message: reason }] } }),
    );
    const err = await createDraft(apiFetch, { packId: 'plumbing', businessName: 'Walsh Plumbing', phone: '+44 7911 123456' }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(OnboardingDraftApiError);
    expect(err).toMatchObject({ status: 400, code: 'VALIDATION_ERROR', issues: [{ path: 'phone', message: reason }] });
    expect((err as OnboardingDraftApiError).issueMessage('phone')).toBe(reason);
    expect((err as OnboardingDraftApiError).issueMessage('businessName')).toBeNull();
  });

  it('reads no reasons from an error body that has none, or whose details are not issues', async () => {
    for (const body of [
      { error: 'VALIDATION_ERROR', message: 'Invalid request data', details: { fields: { phone: ['Too small'] } } },
      { error: 'VALIDATION_ERROR', message: 'Validation failed', details: { issues: 'phone' } },
      { error: 'VALIDATION_ERROR', message: 'Validation failed', details: { issues: [{ path: 'phone' }, { message: 'x' }, null, 4] } },
      { error: 'INTERNAL', message: 'boom' },
    ]) {
      apiFetch.mockResolvedValueOnce(json(400, body));
      const err = (await createDraft(apiFetch, { packId: 'plumbing', businessName: 'Walsh' }).catch((e: unknown) => e)) as OnboardingDraftApiError;
      expect(err.issues).toEqual([]);
      expect(err.issueMessage('phone')).toBeNull();
    }
  });

  it('carries the API error code and message', async () => {
    apiFetch.mockResolvedValueOnce(json(400, { error: 'VALIDATION_ERROR', message: 'TIMEZONE_REQUIRED: the browser timezone must be recorded' }));
    const err = await approveDraft(apiFetch).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 400, code: 'VALIDATION_ERROR', versionConflict: false });
    expect((err as Error).message).toMatch(/TIMEZONE_REQUIRED/);
  });
});
