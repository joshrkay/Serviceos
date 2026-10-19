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
  ONBOARDING_DRAFT_REFUSALS,
  ONBOARDING_DRAFT_RESET_REASONS,
  OnboardingDraftResponseSchema,
  ResetOnboardingDraftResponseSchema,
  RetryOnboardingDraftResponseSchema,
  UndoOnboardingDraftResponseSchema,
  type ApproveOnboardingDraftBody,
  type ApproveOnboardingDraftResponse,
  type CreateOnboardingDraftBody,
  type CreateOnboardingDraftResponse,
  type OnboardingChoiceKey,
  type OnboardingDraft,
  type OnboardingDraftRefusal,
  type OnboardingDraftResetReason,
  type OnboardingMetroCode,
  type ResetOnboardingDraftBody,
  type ResetOnboardingDraftResponse,
  type RetryOnboardingDraftBody,
  type RetryOnboardingDraftResponse,
  type SetOnboardingMetroBody,
  type StagedOnboardingChoice,
  type UndoOnboardingDraftBody,
  type UndoOnboardingDraftResponse,
} from '@ai-service-os/shared';
import type { ApiFetch } from './apiClient';

const DRAFT_PATH = '/api/onboarding/draft';

/** One field the API refused, in its own words (`details.issues[]` of a 400). */
interface DraftFieldIssue {
  path: string;
  message: string;
}

/** The 409 code of a refusal, read from the `CODE: sentence` message; null for anything else. */
function refusalOf(status: number, message: string): OnboardingDraftRefusal | null {
  if (status !== 409) return null;
  const prefix = message.split(':', 1)[0];
  return (ONBOARDING_DRAFT_REFUSALS as readonly string[]).includes(prefix) ? (prefix as OnboardingDraftRefusal) : null;
}

/**
 * A failed draft call. `refusal` names a 409 the draft routes answer on purpose (the message prefix:
 * DRAFT_METRO_LOCKED, for one, means a choice is staged, so the city can no longer change);
 * `versionConflict` means another writer changed the draft first; `resetReason` is why Start over was refused.
 */
export class OnboardingDraftApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly refusal: OnboardingDraftRefusal | null;
  readonly versionConflict: boolean;
  /** `details.reason` of a DRAFT_RESET_REFUSED: part of the setup is `applied`, or `executing` right now. */
  readonly resetReason: OnboardingDraftResetReason | null;
  /** Per-field reasons from a 400; empty for every other failure. */
  readonly issues: readonly DraftFieldIssue[];

  constructor(status: number, code: string, message: string, issues: readonly DraftFieldIssue[] = [], details?: unknown) {
    super(message);
    this.name = 'OnboardingDraftApiError';
    this.status = status;
    this.code = code;
    this.refusal = refusalOf(status, message);
    this.versionConflict = this.refusal === 'VERSION_CONFLICT';
    const reason = (details as { reason?: unknown } | null | undefined)?.reason;
    this.resetReason =
      this.refusal === 'DRAFT_RESET_REFUSED' && (ONBOARDING_DRAFT_RESET_REASONS as readonly unknown[]).includes(reason)
        ? (reason as OnboardingDraftResetReason)
        : null;
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
  let details: unknown;
  try {
    const body = (await res.json()) as { error?: unknown; message?: unknown; details?: unknown };
    if (typeof body.error === 'string') code = body.error;
    if (typeof body.message === 'string') message = body.message;
    issues = readIssues(body.details);
    details = body.details;
  } catch {
    // Non-JSON error body: keep the status-only message.
  }
  return new OnboardingDraftApiError(res.status, code, message, issues, details);
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
 * choice by now rejects with the refusal DRAFT_METRO_LOCKED.
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
 * "Try again" after a save failed: re-queue the changes that did not go through. `expectedVersion` is the
 * approved draft's version the failed screen holds; the response's draft is one version on, and `undoable`
 * says whether the whole set can still be taken back (false after a partial retry).
 */
export async function retryDraft(apiFetch: ApiFetch, expectedVersion: number): Promise<RetryOnboardingDraftResponse> {
  const body: RetryOnboardingDraftBody = { expectedVersion };
  const res = await apiFetch(`${DRAFT_PATH}/retry`, { method: 'POST', body: JSON.stringify(body) });
  if (!res.ok) throw await failure(res);
  return parse(res, RetryOnboardingDraftResponseSchema);
}

/** "Undo" on the saving screen: take back the whole approval or nothing. The draft comes back editable. */
export async function undoDraft(apiFetch: ApiFetch, expectedVersion: number): Promise<UndoOnboardingDraftResponse> {
  const body: UndoOnboardingDraftBody = { expectedVersion };
  const res = await apiFetch(`${DRAFT_PATH}/undo`, { method: 'POST', body: JSON.stringify(body) });
  if (!res.ok) throw await failure(res);
  return parse(res, UndoOnboardingDraftResponseSchema);
}

/** "Start over": return an approval that can no longer finish as one to an editable draft, answers intact. */
export async function resetDraft(apiFetch: ApiFetch, expectedVersion: number): Promise<ResetOnboardingDraftResponse> {
  const body: ResetOnboardingDraftBody = { expectedVersion };
  const res = await apiFetch(`${DRAFT_PATH}/reset`, { method: 'POST', body: JSON.stringify(body) });
  if (!res.ok) throw await failure(res);
  return parse(res, ResetOnboardingDraftResponseSchema);
}
