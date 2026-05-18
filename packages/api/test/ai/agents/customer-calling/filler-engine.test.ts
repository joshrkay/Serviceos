import { describe, it, expect } from 'vitest';
import { FillerEngine } from '../../../../src/ai/agents/customer-calling/filler-engine';
import { FILLER_LIBRARY } from '../../../../src/ai/agents/customer-calling/fillers/manifest';

describe('FillerEngine.selectNext', () => {
  it('returns one of the library entries', () => {
    const engine = new FillerEngine();
    const f = engine.selectNext();
    expect(FILLER_LIBRARY.map((x) => x.id)).toContain(f?.id);
  });

  it('does not return the same filler twice in a row', () => {
    const engine = new FillerEngine();
    const first = engine.selectNext();
    const second = engine.selectNext();
    expect(second?.id).not.toBe(first?.id);
  });

  it('skips selection entirely when skipFillers is true', () => {
    const engine = new FillerEngine();
    const f = engine.selectNext({ skipFillers: true });
    expect(f).toBeUndefined();
  });
});
