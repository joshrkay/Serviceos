import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OnboardingDraftSchema } from '@ai-service-os/shared';
import draftJson from '../components/onboarding/v3/__fixtures__/draft.plumbing-cle.json';
import {
  OnboardingDraftApiError,
  approveDraft,
  createDraft,
  getDraft,
  retryDraft,
  stageChoice,
} from './onboardingDraftApi';

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

  it('retryDraft POSTs /retry with no body and returns the re-queued ids', async () => {
    const approved = { ...draftJson, status: 'approved', version: 2, proposalIds: ['p1', 'p2'], approvedAt: '2026-10-18T10:05:00.000Z' };
    apiFetch.mockResolvedValueOnce(json(200, { draft: approved, retriedProposalIds: ['p2'] }));
    const res = await retryDraft(apiFetch);
    expect(res.retriedProposalIds).toEqual(['p2']);
    expect(res.draft.status).toBe('approved');
    expect(apiFetch).toHaveBeenCalledWith('/api/onboarding/draft/retry', { method: 'POST' });
  });

  it('retryDraft throws the API error for a 409 and for a body that does not match the contract', async () => {
    apiFetch.mockResolvedValueOnce(json(409, { error: 'CONFLICT', message: 'DRAFT_RETRY_NOTHING_FAILED: no proposal is in execution_failed' }));
    await expect(retryDraft(apiFetch)).rejects.toMatchObject({ status: 409, code: 'CONFLICT', versionConflict: false });

    apiFetch.mockResolvedValueOnce(json(200, { draft: draftJson }));
    await expect(retryDraft(apiFetch)).rejects.toMatchObject({ code: 'UNEXPECTED_RESPONSE' });
  });

  it('rejects a response that does not match the shared schema', async () => {
    apiFetch.mockResolvedValueOnce(json(200, { draft: { ...draftJson, version: 'one' } }));
    await expect(getDraft(apiFetch)).rejects.toMatchObject({ code: 'UNEXPECTED_RESPONSE' });
  });

  it('carries the API error code and message', async () => {
    apiFetch.mockResolvedValueOnce(json(400, { error: 'VALIDATION_ERROR', message: 'TIMEZONE_REQUIRED: the browser timezone must be recorded' }));
    const err = await approveDraft(apiFetch).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 400, code: 'VALIDATION_ERROR', versionConflict: false });
    expect((err as Error).message).toMatch(/TIMEZONE_REQUIRED/);
  });
});
