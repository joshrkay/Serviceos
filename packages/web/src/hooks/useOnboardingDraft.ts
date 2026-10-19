import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ApproveOnboardingDraftResponse,
  CreateOnboardingDraftBody,
  OnboardingChoiceKey,
  OnboardingDraft,
  OnboardingMetroCode,
  StagedOnboardingChoice,
} from '@ai-service-os/shared';
import { useApiClient } from '../lib/apiClient';
import {
  OnboardingDraftApiError,
  approveDraft,
  createDraft,
  getDraft,
  setMetro,
  stageChoice,
} from '../lib/onboardingDraftApi';
import { browserTimezoneOrUndefined } from './useOnboardingConversation';

const LOAD_ERROR = "I couldn't load your setup. Check your connection and try again.";
const SAVE_ERROR = "That didn't go through. Try again.";
/** After a re-read that changed what is on screen. Alone when the control the owner tapped may be gone. */
const REFRESHED_NOTICE = 'Your answers changed somewhere else, so I refreshed them.';
const CONFLICT_NOTICE = `${REFRESHED_NOTICE} Tap again.`;

export interface UseOnboardingDraftResult {
  draft: OnboardingDraft | null;
  /** The optimistic-concurrency token sent with every staged choice. */
  version: number | null;
  /** True until the first load (and any create) settles. */
  loading: boolean;
  /** Owner-facing, one line. Cleared by the next successful action. */
  error: string | null;
  /**
   * The API's own words for why it refused the cell on create (a 400 naming `phone`). The owner can
   * fix that on the form, so it is not `error`, whose only way on is to retry the same request.
   */
  cellProblem: string | null;
  /** One-line, non-fatal: the draft was refreshed because another writer got there first. */
  notice: string | null;
  approving: boolean;
  /** Resolves true when staged; false after a refresh-on-conflict or a failure (see `notice` / `error`). */
  stage: (key: OnboardingChoiceKey, choice: StagedOnboardingChoice) => Promise<boolean>;
  /**
   * "Not Cleveland?": re-price the shop for another city. The re-priced draft when saved; null after a
   * refresh (any 409: the draft moved on, a choice was staged elsewhere, or it was approved) or a failure.
   * Never repeated.
   */
  changeMetro: (metro: OnboardingMetroCode) => Promise<OnboardingDraft | null>;
  /** The approve response, or null when it did not go through. */
  approve: () => Promise<ApproveOnboardingDraftResponse | null>;
  reload: () => Promise<void>;
}

/**
 * Load-or-create the tenant's onboarding draft and keep it in step with the
 * server. With `createInput` null it only reads (a 404 leaves `draft` null); with an
 * input it creates the draft when none exists. The create is idempotent on the
 * API, and the browser timezone is always sent: approval refuses a draft that
 * has no zone, and a guessed zone would misbook every appointment.
 *
 * A create the API refuses over the cell (400 naming `phone`) is not a load failure: it comes back as
 * `cellProblem` with no `error`, so the shell can return to the form and let the owner correct the number.
 *
 * Writes carry the draft `version`. On a 409 VERSION_CONFLICT the hook re-reads
 * the draft and sets a one-line `notice` instead of failing the owner.
 */
export function useOnboardingDraft(createInput: CreateOnboardingDraftBody | null): UseOnboardingDraftResult {
  const apiFetch = useApiClient();
  const [draft, setDraft] = useState<OnboardingDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cellProblem, setCellProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [approving, setApproving] = useState(false);

  const draftRef = useRef<OnboardingDraft | null>(null);
  const queueRef = useRef<Promise<unknown>>(Promise.resolve());
  const createKey = createInput ? JSON.stringify(createInput) : null;
  const input = useMemo<CreateOnboardingDraftBody | null>(
    () => (createKey ? (JSON.parse(createKey) as CreateOnboardingDraftBody) : null),
    [createKey],
  );

  const commit = useCallback((next: OnboardingDraft | null) => {
    draftRef.current = next;
    setDraft(next);
  }, []);

  const load = useCallback(
    async (isStale: () => boolean) => {
      setLoading(true);
      setError(null);
      setCellProblem(null);
      try {
        let next = await getDraft(apiFetch);
        if (!next && input) {
          next = (await createDraft(apiFetch, { ...input, clientTimezone: input.clientTimezone ?? browserTimezoneOrUndefined() })).draft;
        } else if (next) {
          // Best effort here: approve tries again before it sends, so a failure now is not a dead end.
          const loaded = next;
          next = await recordTimezone(apiFetch, loaded, input?.clientTimezone).catch(() => loaded);
        }
        if (!isStale()) commit(next);
      } catch (err) {
        if (!isStale()) {
          const refusedCell = err instanceof OnboardingDraftApiError && err.status === 400 ? err.issueMessage('phone') : null;
          if (refusedCell) setCellProblem(refusedCell);
          else setError(LOAD_ERROR);
        }
      } finally {
        if (!isStale()) setLoading(false);
      }
    },
    [apiFetch, input, commit],
  );

  useEffect(() => {
    let stale = false;
    void load(() => stale);
    return () => {
      stale = true;
    };
  }, [load]);

  const reload = useCallback(() => load(() => false), [load]);

  /** Writes run one at a time so a quick second tap carries the version the first one returned. */
  const serially = useCallback(<T>(task: () => Promise<T>): Promise<T> => {
    const run = queueRef.current.then(task, task);
    queueRef.current = run.catch(() => undefined);
    return run;
  }, []);

  /** Re-read after a conflict. Returns false (and sets `error`) when the re-read itself fails. */
  const refresh = useCallback(async (): Promise<boolean> => {
    try {
      commit(await getDraft(apiFetch));
      return true;
    } catch {
      setError(LOAD_ERROR);
      return false;
    }
  }, [apiFetch, commit]);

  const stage = useCallback(
    (key: OnboardingChoiceKey, choice: StagedOnboardingChoice): Promise<boolean> =>
      serially(async () => {
        const current = draftRef.current;
        if (!current) return false;
        setError(null);
        setNotice(null);
        try {
          commit(await stageChoice(apiFetch, key, choice, current.version));
          return true;
        } catch (err) {
          if (err instanceof OnboardingDraftApiError && err.status === 409) {
            // Either another writer moved the version, or the draft was approved
            // elsewhere (DRAFT_APPROVED). Re-read so the shell shows the server's
            // state instead of a dead-end "try again" on a draft that is finished.
            const refreshed = await refresh();
            if (refreshed && err.versionConflict) setNotice(CONFLICT_NOTICE);
            else if (refreshed && draftRef.current?.status !== 'approved') setError(SAVE_ERROR);
          } else {
            setError(SAVE_ERROR);
          }
          return false;
        }
      }),
    [apiFetch, commit, refresh, serially],
  );

  const changeMetro = useCallback(
    (metro: OnboardingMetroCode): Promise<OnboardingDraft | null> =>
      serially(async () => {
        const current = draftRef.current;
        if (!current) return null;
        setError(null);
        setNotice(null);
        try {
          const next = await setMetro(apiFetch, metro, current.version);
          commit(next);
          return next;
        } catch (err) {
          if (err instanceof OnboardingDraftApiError && err.status === 409) {
            // The draft moved on (VERSION_CONFLICT), a choice was staged in another window
            // (DRAFT_METRO_LOCKED), or it was approved (DRAFT_APPROVED). Re-read once and show what is
            // current; the call is not repeated, because the screen it came from may be gone.
            const refreshed = await refresh();
            if (refreshed && draftRef.current?.status !== 'approved') setNotice(REFRESHED_NOTICE);
          } else {
            setError(SAVE_ERROR);
          }
          return null;
        }
      }),
    [apiFetch, commit, refresh, serially],
  );

  const approve = useCallback(
    (): Promise<ApproveOnboardingDraftResponse | null> =>
      serially(async () => {
        setError(null);
        setNotice(null);
        setApproving(true);
        try {
          // A zone that could not be recorded when the draft loaded is recorded now: the API refuses to
          // approve a draft without one, and only this call can lift that.
          const held = draftRef.current;
          if (held && held.status === 'draft' && held.clientTimezone === null) {
            try {
              commit(await recordTimezone(apiFetch, held, input?.clientTimezone));
            } catch {
              setError(SAVE_ERROR);
              return null;
            }
          }
          // The version is read here, after earlier writes in the queue have landed, so it is the one the
          // read-back on screen was rendered from. A stale tab then gets a 409 instead of approving a read-back
          // that changed, and a repeat tap is told apart from a stale one.
          const res = await approveDraft(apiFetch, draftRef.current?.version);
          commit(res.draft);
          return res;
        } catch (err) {
          if (err instanceof OnboardingDraftApiError && err.status === 409) {
            // Re-read so the shell shows the server's state. If that says the draft is approved (the other tab
            // got there first) the shell moves on by itself and there is nothing to ask. A VERSION_CONFLICT on a
            // draft that is still a draft means the answers changed: say so. Any other 409 is
            // DRAFT_APPROVAL_FAILED (the transaction rolled back): a plain re-tap.
            const refreshed = await refresh();
            if (refreshed && draftRef.current?.status !== 'approved') {
              if (err.versionConflict) setNotice(CONFLICT_NOTICE);
              else setError(SAVE_ERROR);
            }
          } else {
            setError(SAVE_ERROR);
          }
          return null;
        } finally {
          setApproving(false);
        }
      }),
    [apiFetch, commit, refresh, serially, input],
  );

  return { draft, version: draft?.version ?? null, loading, error, cellProblem, notice, approving, stage, changeMetro, approve, reload };
}


/**
 * A draft saved without a zone can never be approved (the API refuses rather
 * than guess one), so an owner who reloads keeps hitting the same wall. The
 * create route is idempotent and records a zone on an existing unapproved
 * draft, so re-post the draft's own facts with the zone we can detect now.
 * Returns the draft unchanged when there is nothing to record (approved, already
 * zoned, or no zone detectable); rejects when the call fails, so the caller
 * decides: the load shows the draft anyway, and approve tries once more first.
 */
async function recordTimezone(
  apiFetch: Parameters<typeof getDraft>[0],
  draft: OnboardingDraft,
  preferredTimezone: string | undefined,
): Promise<OnboardingDraft> {
  if (draft.status !== 'draft' || draft.clientTimezone !== null) return draft;
  const clientTimezone = preferredTimezone ?? browserTimezoneOrUndefined();
  if (!clientTimezone) return draft;
  const res = await createDraft(apiFetch, {
    packId: draft.packId,
    businessName: draft.businessName,
    ...(draft.ownerFirstName ? { ownerFirstName: draft.ownerFirstName } : {}),
    clientTimezone,
  });
  return res.draft;
}
