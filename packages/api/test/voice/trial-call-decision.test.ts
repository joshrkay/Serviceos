import { describe, it, expect } from 'vitest';
import { decideTrialCall } from '../../src/voice/trial-limits';

describe('decideTrialCall', () => {
  it('answers while the trial is under its 25-call cap', () => {
    expect(decideTrialCall({ billableCallsUsed: 13, concurrentCalls: 0 })).toEqual({
      action: 'answer',
      upgradeNudgeDue: false,
    });
  });

  it('makes the upgrade nudge due once 15 trial calls are used', () => {
    expect(decideTrialCall({ billableCallsUsed: 14, concurrentCalls: 0 }).upgradeNudgeDue).toBe(false);
    expect(decideTrialCall({ billableCallsUsed: 15, concurrentCalls: 0 })).toEqual({
      action: 'answer',
      upgradeNudgeDue: true,
    });
  });

  it('answers call 25 and forwards call 26 to the owner', () => {
    expect(decideTrialCall({ billableCallsUsed: 24, concurrentCalls: 0 }).action).toBe('answer');
    expect(decideTrialCall({ billableCallsUsed: 25, concurrentCalls: 0 })).toEqual({
      action: 'forward_to_owner',
      reason: 'trial_cap_total',
      upgradeNudgeDue: true,
    });
  });

  it('forwards a third concurrent trial call to the owner', () => {
    expect(decideTrialCall({ billableCallsUsed: 3, concurrentCalls: 1 }).action).toBe('answer');
    expect(decideTrialCall({ billableCallsUsed: 3, concurrentCalls: 2 })).toEqual({
      action: 'forward_to_owner',
      reason: 'trial_cap_concurrent',
      upgradeNudgeDue: false,
    });
  });
});
