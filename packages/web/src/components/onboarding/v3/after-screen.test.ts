import { describe, expect, it } from 'vitest';
import type { OnboardingDraftExecution, OnboardingStatusResponse, OnboardingStep, OnboardingStepId } from '../../../types/onboarding';
import { afterControls, afterRecovery, afterScreen, afterStage, latestUndoHint, phoneNumberOf, statusUndoHint, stepOf, type AfterControl, type AfterScreen } from './after-screen';

function status(currentStep: OnboardingStepId | null, steps: OnboardingStep[] = []): OnboardingStatusResponse {
  return { steps, currentStep, isComplete: currentStep === null, voiceAgentLive: false, tenantId: 't', subscriptionStatus: null };
}

describe('afterScreen', () => {
  it('waits while the saved choices go live, and before the first status has arrived', () => {
    expect(afterScreen(null)).toBe('wait');
    expect(afterScreen(status('signup'))).toBe('wait');
    expect(afterScreen(status('identity'))).toBe('wait');
    expect(afterScreen(status('pack'))).toBe('wait');
  });

  it('follows the order the API derives once the choices are live: trial, number, getting ready, test call', () => {
    expect(afterScreen(status('billing'))).toBe('trial');
    expect(afterScreen(status('phone'))).toBe('number');
    expect(afterScreen(status('ai_check'))).toBe('getting_ready');
    expect(afterScreen(status('test_call'))).toBe('test_call');
  });

  it('has nothing to show for a finished setup, which the shell hands off', () => {
    expect(afterScreen(status(null))).toBe('wait');
  });

  describe('when a saved change did not go live', () => {
    const withExecution = (currentStep: OnboardingStepId | null, execution: OnboardingDraftExecution | null | undefined): OnboardingStatusResponse => ({
      ...status(currentStep),
      draft: { status: 'approved', choicesAnswered: 7, version: 2, ...(execution === undefined ? {} : { execution }) },
    });

    it('says so instead of waiting when the save failed, and when it can never finish', () => {
      expect(afterScreen(withExecution('identity', 'failed'))).toBe('save_failed');
      expect(afterScreen(withExecution('pack', 'stopped'))).toBe('save_stopped');
    });

    it('keeps waiting while the changes are queued or running, or the status says nothing about them', () => {
      for (const execution of ['pending', 'executing', 'executed', null, undefined] as const) {
        expect(afterScreen(withExecution('identity', execution)), String(execution)).toBe('wait');
      }
      expect(afterScreen({ ...status('identity') })).toBe('wait');
    });

    // The two saved changes go live independently: the settings can be done (the setup moves on to the trial)
    // while the voice policy failed or was undone. The trial or a test call would then show a setup that is not
    // the one the owner approved, so a change that did not go live outranks the next step.
    it('outranks the next step: the setup moving on does not hide a change that did not go live', () => {
      for (const step of ['billing', 'phone', 'ai_check', 'test_call'] as const) {
        expect(afterScreen(withExecution(step, 'failed')), `${step} failed`).toBe('save_failed');
        expect(afterScreen(withExecution(step, 'stopped')), `${step} stopped`).toBe('save_stopped');
      }
    });

    it('lets the next step through again once nothing failed or stopped', () => {
      for (const execution of ['pending', 'executing', 'executed', null, undefined] as const) {
        expect(afterScreen(withExecution('billing', execution)), String(execution)).toBe('trial');
      }
    });
  });
});

describe('stepOf and phoneNumberOf', () => {
  const steps: OnboardingStep[] = [
    { id: 'phone', status: 'current', metadata: { phoneNumber: '+12165550180', lineState: 'active' } },
    { id: 'test_call', status: 'pending' },
  ];

  it('finds a step by id', () => {
    expect(stepOf(status('phone', steps), 'phone')?.status).toBe('current');
    expect(stepOf(status('phone', steps), 'billing')).toBeUndefined();
    expect(stepOf(null, 'phone')).toBeUndefined();
  });

  it('reads the number from the phone step, only when it is a non-empty string', () => {
    expect(phoneNumberOf(status('phone', steps))).toBe('+12165550180');
    expect(phoneNumberOf(status('phone', [{ id: 'phone', status: 'current' }]))).toBeNull();
    expect(phoneNumberOf(status('phone', [{ id: 'phone', status: 'current', metadata: { phoneNumber: '' } }]))).toBeNull();
    expect(phoneNumberOf(status('phone', [{ id: 'phone', status: 'current', metadata: { phoneNumber: 5551234 } }]))).toBeNull();
    expect(phoneNumberOf(null)).toBeNull();
  });
});

describe('afterStage', () => {
  it('is saving for as long as the undo window is open, whichever screen the status would show', () => {
    for (const screen of ['wait', 'trial', 'number', 'getting_ready', 'test_call'] as const) {
      expect(afterStage(screen, true, false)).toBe('saving');
    }
  });

  it('gives each screen its place in the header, with the voice getting ready counted as the test call', () => {
    expect(afterStage('wait', false, false)).toBe('wait');
    expect(afterStage('save_failed', false, false)).toBe('wait');
    expect(afterStage('save_stopped', false, false)).toBe('wait');
    expect(afterStage('trial', false, false)).toBe('trial');
    expect(afterStage('number', false, false)).toBe('number');
    expect(afterStage('getting_ready', false, false)).toBe('test_call');
    expect(afterStage('test_call', false, false)).toBe('test_call');
  });

  it('is open once the call was heard', () => {
    expect(afterStage('test_call', false, true)).toBe('open');
  });
});

describe('what the owner can do on each screen after approval', () => {
  // [screen, saving, undoable, recovery, controls offered]
  const table: Array<[AfterScreen, boolean, boolean, 'reset' | 'settings' | undefined, AfterControl[]]> = [
    // The saving window: Undo only while the latest hint says the whole set can still be taken back.
    ['wait', true, true, undefined, ['undo']],
    ['wait', true, false, undefined, []],
    ['trial', true, true, undefined, ['undo']],
    // Failed: Try again always; Start over only while the reset can run.
    ['save_failed', false, false, 'reset', ['retry', 'start_over', 'step_by_step']],
    ['save_failed', false, false, 'settings', ['retry', 'step_by_step']],
    ['save_failed', false, false, undefined, ['retry', 'step_by_step']],
    // Stopped: never Try again. Start over, or the way to Settings, never both.
    ['save_stopped', false, false, 'reset', ['start_over', 'step_by_step']],
    ['save_stopped', false, false, 'settings', ['settings', 'step_by_step']],
    // An API that predates the hint: only the step-by-step way out, as before.
    ['save_stopped', false, false, undefined, ['step_by_step']],
    // Undo is a saving-window control: a stale true hint on any later screen offers nothing.
    ['wait', false, true, undefined, []],
    ['save_failed', false, true, 'reset', ['retry', 'start_over', 'step_by_step']],
  ];
  for (const [screen, saving, undoable, recovery, controls] of table) {
    it(`${screen}${saving ? ' while saving' : ''}, undoable ${undoable}, recovery ${recovery ?? 'none'}: ${controls.join(', ') || 'nothing'}`, () => {
      expect(afterControls(screen, { saving, undoable, recovery })).toEqual(controls);
    });
  }
});

describe('the undo hint the screen holds', () => {
  const approvedStatus = (version: number, undoable?: boolean): OnboardingStatusResponse => ({
    ...status('identity'),
    draft: { status: 'approved', choicesAnswered: 7, version, execution: 'pending', ...(undoable === undefined ? {} : { undoable }) },
  });

  it('reads a hint only from an approved draft block; an unset one on an approved draft means no Undo', () => {
    expect(statusUndoHint(null)).toBeNull();
    expect(statusUndoHint(status('identity'))).toBeNull();
    expect(statusUndoHint({ ...status('identity'), draft: { status: 'draft', choicesAnswered: 7, version: 3 } })).toBeNull();
    expect(statusUndoHint(approvedStatus(2, true))).toEqual({ version: 2, undoable: true });
    expect(statusUndoHint(approvedStatus(2))).toEqual({ version: 2, undoable: false });
  });

  it('takes the newest: a poll for the same or a later approval replaces it, a poll from before it does not', () => {
    const afterRetry = { version: 3, undoable: false };
    expect(latestUndoHint(afterRetry, { version: 3, undoable: true })).toEqual({ version: 3, undoable: true });
    expect(latestUndoHint(afterRetry, { version: 4, undoable: false })).toEqual({ version: 4, undoable: false });
    expect(latestUndoHint(afterRetry, { version: 2, undoable: true })).toBe(afterRetry);
    expect(latestUndoHint(afterRetry, null)).toBe(afterRetry);
  });
});

describe('the way out the screen offers for a set that cannot finish as one', () => {
  const stopped = (version: number, recovery?: 'reset' | 'settings'): OnboardingStatusResponse => ({
    ...status('identity'),
    draft: { status: 'approved', choicesAnswered: 7, version, execution: 'stopped', ...(recovery ? { recovery } : {}) },
  });

  it('follows the status, unless Start over was already refused for this approval because part of it went through', () => {
    expect(afterRecovery(stopped(2, 'reset'), null)).toBe('reset');
    expect(afterRecovery(stopped(2, 'settings'), null)).toBe('settings');
    expect(afterRecovery(stopped(2), null)).toBeUndefined();
    expect(afterRecovery(null, null)).toBeUndefined();
    // A refusal for this version is final for it, whatever a cached status still says.
    expect(afterRecovery(stopped(2, 'reset'), 2)).toBe('settings');
    // Another window started over and approved again since: that approval is judged afresh.
    expect(afterRecovery(stopped(4, 'reset'), 2)).toBe('reset');
  });

  it('holds the wait screen instead of a failed or stopped one while part of the set is being saved', () => {
    expect(afterScreen(stopped(2, 'reset'), { holdWait: true })).toBe('wait');
    expect(afterScreen({ ...stopped(2, 'reset'), currentStep: 'billing' }, { holdWait: true })).toBe('trial');
    expect(afterScreen(stopped(2, 'reset'), { holdWait: false })).toBe('save_stopped');
  });
});
