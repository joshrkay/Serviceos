import { describe, it, expect } from 'vitest';
import { decideTrialCall } from '../../src/voice/trial-limits';

describe('decideTrialCall', () => {
  it('answers while the trial is under its 60 AI minutes', () => {
    expect(decideTrialCall({ billableSecondsUsed: 1_000, concurrentCalls: 0 })).toEqual({
      action: 'answer',
      upgradeNudgeDue: false,
    });
  });

  it('makes the upgrade nudge due at 40 trial minutes', () => {
    expect(decideTrialCall({ billableSecondsUsed: 2_399, concurrentCalls: 0 }).upgradeNudgeDue).toBe(false);
    expect(decideTrialCall({ billableSecondsUsed: 2_400, concurrentCalls: 0 })).toEqual({
      action: 'answer',
      upgradeNudgeDue: true,
    });
  });

  it('forwards to the owner once 60 trial minutes are used', () => {
    expect(decideTrialCall({ billableSecondsUsed: 3_599, concurrentCalls: 0 }).action).toBe('answer');
    expect(decideTrialCall({ billableSecondsUsed: 3_600, concurrentCalls: 0 })).toEqual({
      action: 'forward_to_owner',
      reason: 'trial_cap_total',
      upgradeNudgeDue: true,
    });
  });

  it('forwards a third concurrent trial call to the owner', () => {
    expect(decideTrialCall({ billableSecondsUsed: 300, concurrentCalls: 1 }).action).toBe('answer');
    expect(decideTrialCall({ billableSecondsUsed: 300, concurrentCalls: 2 })).toEqual({
      action: 'forward_to_owner',
      reason: 'trial_cap_concurrent',
      upgradeNudgeDue: false,
    });
  });
});
