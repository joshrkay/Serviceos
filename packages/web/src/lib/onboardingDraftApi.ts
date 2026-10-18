/**
 * Typed client for the onboarding draft API ("pick, don't build" setup).
 *
 * Request and response shapes are the schemas in @ai-service-os/shared, which
 * the API's wire-contract test pins. Auth, base URL and the 401 retry come from
 * the `apiFetch` the caller passes (useApiClient), exactly as the other
 * onboarding hooks do.
 */
import {
  ApproveOnboardingDraftResponseSchema,
  CreateOnboardingDraftResponseSchema,
  OnboardingDraftResponseSchema,
  type ApproveOnboardingDraftResponse,
  type CreateOnboardingDraftBody,
  type CreateOnboardingDraftResponse,
  type OnboardingChoiceKey,
  type OnboardingDraft,
  type StagedOnboardingChoice,
} from '@ai-service-os/shared';
import type { ApiFetch } from './apiClient';

const DRAFT_PATH = '/api/onboarding/draft';

/** A failed draft call. `versionConflict` means another writer changed the draft first. */
export class OnboardingDraftApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly versionConflict: boolean;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'OnboardingDraftApiError';
    this.status = status;
    this.code = code;
    this.versionConflict = status === 409 && message.startsWith('VERSION_CONFLICT');
  }
}

async function failure(res: Response): Promise<OnboardingDraftApiError> {
  let code = 'HTTP_ERROR';
  let message = `HTTP ${res.status}`;
  try {
    const body = (await res.json()) as { error?: unknown; message?: unknown };
    if (typeof body.error === 'string') code = body.error;
    if (typeof body.message === 'string') message = body.message;
  } catch {
    // Non-JSON error body: keep the status-only message.
  }
  return new OnboardingDraftApiError(res.status, code, message);
}

async function parse<T>(res: Response, schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } }): Promise<T> {
  const parsed = schema.safeParse(await res.json());
  if (!parsed.success) {
    throw new OnboardingDraftApiError(res.status, 'UNEXPECTED_RESPONSE', 'The draft response did not match the shared contract');
  }
  return parsed.data;
}

/** The tenant's draft, or null when none exists yet. */
export async function getDraft(apiFetch: ApiFetch): Promise<OnboardingDraft | null> {
  const res = await apiFetch(DRAFT_PATH);
  if (res.status === 404) return null;
  if (!res.ok) throw await failure(res);
  return (await parse(res, OnboardingDraftResponseSchema)).draft;
}

/** Idempotent: an existing draft comes back unchanged with `created: false`. */
export async function createDraft(apiFetch: ApiFetch, body: CreateOnboardingDraftBody): Promise<CreateOnboardingDraftResponse> {
  const res = await apiFetch(DRAFT_PATH, { method: 'POST', body: JSON.stringify(body) });
  if (!res.ok) throw await failure(res);
  return parse(res, CreateOnboardingDraftResponseSchema);
}

/** Compare-and-swap on `version`: a stale version rejects with `versionConflict`. */
export async function stageChoice(
  apiFetch: ApiFetch,
  key: OnboardingChoiceKey,
  choice: StagedOnboardingChoice,
  version: number,
): Promise<OnboardingDraft> {
  const res = await apiFetch(`${DRAFT_PATH}/choices/${key}`, {
    method: 'PUT',
    body: JSON.stringify({ choice, version }),
  });
  if (!res.ok) throw await failure(res);
  return (await parse(res, OnboardingDraftResponseSchema)).draft;
}

/** "That's right": the API mints and approves two proposals; a repeat call is an idempotent read. */
export async function approveDraft(apiFetch: ApiFetch): Promise<ApproveOnboardingDraftResponse> {
  const res = await apiFetch(`${DRAFT_PATH}/approve`, { method: 'POST', body: '{}' });
  if (!res.ok) throw await failure(res);
  return parse(res, ApproveOnboardingDraftResponseSchema);
}
