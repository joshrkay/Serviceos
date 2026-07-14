import { describe, it, expect } from 'vitest';
import { isTerminalSdkAvailable, TERMINAL_UNAVAILABLE_REASON } from './terminalTypes';

describe('terminalTypes', () => {
  it('exports isTerminalSdkAvailable as a boolean gate', () => {
    expect(typeof isTerminalSdkAvailable()).toBe('boolean');
  });

  it('exports a clear unavailable reason for Expo Go / web fallbacks', () => {
    expect(TERMINAL_UNAVAILABLE_REASON).toMatch(/EAS build/i);
  });
});
