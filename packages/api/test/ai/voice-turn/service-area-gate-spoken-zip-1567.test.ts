import { describe, it, expect } from 'vitest';
import { spokenZip } from '../../../src/ai/voice-turn/service-area-gate';

/** #1567 — the ZIP a caller says, as STT hands it to us. */
describe('spokenZip', () => {
  it.each([
    ["I'm in 30309 Atlanta", '30309'],
    ['the zip is 90012-1234', '90012'],
    ['nine zero zero one two', '90012'],
    ['three oh three oh nine', '30309'],
    ['nueve cero cero cero uno', '90001'],
    ['9 0 0 1 2', '90012'],
  ])('%s → %s', (utterance, zip) => {
    expect(spokenZip(utterance)).toBe(zip);
  });

  it.each([
    ['call me back at 5125550100'],
    ["I'd like to schedule HVAC service"],
    ['it is on 123 Main Street'],
  ])('%s → no ZIP', (utterance) => {
    expect(spokenZip(utterance)).toBeNull();
  });
});
