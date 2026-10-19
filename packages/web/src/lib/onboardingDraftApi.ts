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
  RetryOnboardingDraftResponseSchema,
  type ApproveOnboardingDraftBody,
  type ApproveOnboardingDraftResponse,
  type CreateOnboardingDraftBody,
  type CreateOnboardingDraftResponse,
  type OnboardingChoiceKey,
  type OnboardingDraft,
  type OnboardingMetroCode,
  type RetryOnboardingDraftResponse,
  type SetOnboardingMetroBody,
  type StagedOnboardingChoice,
} from '@ai-service-os/shared';
import type { ApiFetch } from './apiClient';

const DRAFT_PATH = '/api/onboarding/draft';

/** One field the API refused, in its own words (`details.issues[]` of a 400). */
interface DraftFieldIssue {
  path: string;
  message: string;
}

/**
 * A failed draft call. `versionConflict` means another writer changed the draft first;
 * `metroLocked` means a choice is staged, so the city can no longer change.
 */
export class OnboardingDraftApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly versionConflict: boolean;
  readonly metroLocked: boolean;
  /** Per-field reasons from a 400; empty for every other failure. */
  readonly issues: readonly DraftFieldIssue[];

  constructor(status: number, code: string, message: string, issues: readonly DraftFieldIssue[] = []) {
    super(message);
    this.name = 'OnboardingDraftApiError';
    this.status = status;
    this.code = code;
    this.versionConflict = status === 409 && message.startsWith('VERSION_CONFLICT');
    this.metroLocked = status === 409 && message.startsWith('DRAFT_METRO_LOCKED');
    this.issues = issues;
  }

  /** The API's reason it refused the field at `path`, or null when it named no such field. */
  issueMessage(path: string): string | null {
    return this.issues.find((issue) => issue.path === path)?.message ?? null;
  }
}

function readIssues(details: unknown): DraftFieldIssue[] {
  const issues = (details as { issues?: unknown } | null | undefined)?.issues;
  if (!Array.isArray(issues)) return [];
  return issues.flatMap((issue: unknown) => {
    const { path, message } = (issue ?? {}) as { path?: unknown; message?: unknown };
    return typeof path === 'string' && typeof message === 'string' ? [{ path, message }] : [];
  });
}

async function failure(res: Response): Promise<OnboardingDraftApiError> {
  let code = 'HTTP_ERROR';
  let message = `HTTP ${res.status}`;
  let issues: DraftFieldIssue[] = [];
  try {
    const body = (await res.json()) as { error?: unknown; message?: unknown; details?: unknown };
    if (typeof body.error === 'string') code = body.error;
    if (typeof body.message === 'string') message = body.message;
    issues = readIssues(body.details);
  } catch {
    // Non-JSON error body: keep the status-only message.
  }
  return new OnboardingDraftApiError(res.status, code, message, issues);
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

/**
 * "Not Cleveland?": re-price a draft with nothing staged for another curated city. `version` is the one
 * the Ready screen rendered; a stale one rejects with `versionConflict`, and a draft that has a staged
 * choice by now rejects with `metroLocked`.
 */
export async function setMetro(apiFetch: ApiFetch, metro: OnboardingMetroCode, version: number): Promise<OnboardingDraft> {
  const body: SetOnboardingMetroBody = { metro, version };
  const res = await apiFetch(`${DRAFT_PATH}/metro`, { method: 'PUT', body: JSON.stringify(body) });
  if (!res.ok) throw await failure(res);
  return (await parse(res, OnboardingDraftResponseSchema)).draft;
}

/**
 * "That's right": the API mints and approves two proposals; a repeat call is an idempotent read.
 * `expectedVersion` is the draft version the read-back on screen was rendered from: the API answers
 * 409 VERSION_CONFLICT when the draft has changed since (a stale tab), and an API that predates the
 * field ignores it.
 */
export async function approveDraft(apiFetch: ApiFetch, expectedVersion?: number): Promise<ApproveOnboardingDraftResponse> {
  const body: ApproveOnboardingDraftBody = expectedVersion === undefined ? {} : { expectedVersion };
  const res = await apiFetch(`${DRAFT_PATH}/approve`, { method: 'POST', body: JSON.stringify(body) });
  if (!res.ok) throw await failure(res);
  return parse(res, ApproveOnboardingDraftResponseSchema);
}

/**
 * After a save failed: re-queue the changes that did not go through. Owner only, no body. Any 409
 * (nothing failed any more, not approved, not safe to retry) means the status moved on: re-read it.
 */
export async function retryDraft(apiFetch: ApiFetch): Promise<RetryOnboardingDraftResponse> {
  const res = await apiFetch(`${DRAFT_PATH}/retry`, { method: 'POST' });
  if (!res.ok) throw await failure(res);
  return parse(res, RetryOnboardingDraftResponseSchema);
}
