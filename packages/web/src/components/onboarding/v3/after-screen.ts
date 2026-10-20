import type { OnboardingDraftRecovery } from '@ai-service-os/shared';
import type { OnboardingStatusResponse, OnboardingStep, OnboardingStepId } from '../../../types/onboarding';
import type { AfterStage } from './pacing';

/**
 * Which turn the owner is on once "That's right" has gone through and the
 * saved choices are live. Derived from the same status the API computes
 * (onboarding/derive-status.ts: trial, then the number, then the voice
 * check, then the test call), so the screen can never run ahead of the facts.
 *
 * `getting_ready` is the pre-state of the test call: the voice check has no
 * screen of its own. `save_failed` and `save_stopped` are shown when the status
 * says a saved change will not go live by waiting: it failed (a retry can fix
 * it), or it was undone or rejected (nothing here can finish it). They outrank
 * the next step, because the two saved changes go live independently: the
 * settings can be done, and the setup on to the trial, while the voice policy
 * failed, and a trial or test call would then show a setup the owner did not
 * approve.
 */
export type AfterScreen = 'wait' | 'save_failed' | 'save_stopped' | 'trial' | 'number' | 'getting_ready' | 'test_call';

export function afterScreen(status: OnboardingStatusResponse | null, opts: { holdWait?: boolean } = {}): AfterScreen {
  // `holdWait`: Start over was just refused because part of the set is being saved right now. The status
  // re-read says the same set failed or stopped; the owner waits for the next one instead of tapping again.
  if (!opts.holdWait) {
    if (status?.draft?.execution === 'failed') return 'save_failed';
    if (status?.draft?.execution === 'stopped') return 'save_stopped';
  }
  switch (status?.currentStep) {
    case 'billing':
      return 'trial';
    case 'phone':
      return 'number';
    case 'ai_check':
      return 'getting_ready';
    case 'test_call':
      return 'test_call';
    // signup, identity and pack are the saved choices going live; null is a finished setup (handed off).
    default:
      return 'wait';
  }
}

/** The header and progress stage for a screen: the voice getting ready is part of the test call, and a heard call is the end. */
export function afterStage(screen: AfterScreen, saving: boolean, heard: boolean): AfterStage {
  if (saving) return 'saving';
  switch (screen) {
    case 'wait':
    case 'save_failed':
    case 'save_stopped':
      return 'wait';
    case 'trial':
      return 'trial';
    case 'number':
      return 'number';
    case 'getting_ready':
      return 'test_call';
    case 'test_call':
      return heard ? 'open' : 'test_call';
  }
}

export function stepOf(status: OnboardingStatusResponse | null, id: OnboardingStepId): OnboardingStep | undefined {
  return status?.steps.find((s) => s.id === id);
}

/** The business number, once the API reports one on the phone step. */
export function phoneNumberOf(status: OnboardingStatusResponse | null): string | null {
  const value = stepOf(status, 'phone')?.metadata?.phoneNumber;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** A control a screen after approval offers, besides moving on through setup. */
export type AfterControl = 'undo' | 'retry' | 'start_over' | 'settings' | 'step_by_step';

/**
 * Which controls a screen offers. Undo belongs to the saving window and shows only while the latest hint
 * says the whole set can still be taken back. A failed save can always be tried again; Start over shows only
 * while the reset can run (`recovery: 'reset'`). A stopped set is never retried: it offers Start over, or
 * the way to Settings when part of it already went through. Going step by step stays as the secondary way
 * out of both until the sidebar shell is retired. An API that predates `recovery` offers neither.
 */
export function afterControls(
  screen: AfterScreen,
  { saving, undoable, recovery }: { saving: boolean; undoable: boolean; recovery: OnboardingDraftRecovery | undefined },
): AfterControl[] {
  if (saving) return undoable ? ['undo'] : [];
  if (screen === 'save_failed') return ['retry', ...(recovery === 'reset' ? (['start_over'] as const) : []), 'step_by_step'];
  if (screen === 'save_stopped') {
    if (recovery === 'reset') return ['start_over', 'step_by_step'];
    if (recovery === 'settings') return ['settings', 'step_by_step'];
    return ['step_by_step'];
  }
  return [];
}

/** Whether Undo can still take back the whole approval, as last heard, and for which version of it. */
export interface UndoHint {
  version: number;
  undoable: boolean;
}

/** The status's hint, for an approved draft only (an unset one means no Undo); null otherwise. */
export function statusUndoHint(status: OnboardingStatusResponse | null): UndoHint | null {
  const draft = status?.draft;
  if (draft?.status !== 'approved') return null;
  return { version: draft.version, undoable: draft.undoable === true };
}

/**
 * The newest hint wins: one for the same approval or a later one (a poll, or another window's retry)
 * replaces the held one; one from before it (a poll that left before the approve or retry) does not.
 * A hint, never a guard: the undo endpoint decides.
 */
export function latestUndoHint(held: UndoHint, incoming: UndoHint | null): UndoHint {
  return incoming && incoming.version >= held.version ? incoming : held;
}

/**
 * The way out for a set that cannot finish as one. The status's `recovery`, except that once Start over
 * was refused for this approval because part of it went through (or its window closed), only Settings is
 * offered for it, whatever a cached status still says, so the owner is never offered a refused button twice.
 */
export function afterRecovery(
  status: OnboardingStatusResponse | null,
  settingsForVersion: number | null,
): OnboardingDraftRecovery | undefined {
  const draft = status?.draft;
  if (!draft) return undefined;
  if (settingsForVersion !== null && draft.version === settingsForVersion) return 'settings';
  return draft.recovery;
}
