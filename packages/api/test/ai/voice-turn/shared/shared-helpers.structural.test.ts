/**
 * #1601 step 2 — the shared voice helpers stay small and stay the set the
 * epic named.
 *
 * The epic's target: helpers under 200 lines each, pinned by a size test.
 * A helper that outgrows that is becoming a second engine — split it or
 * move the behaviour into the turn pipeline instead. The file list is pinned
 * too, so a new helper is a deliberate addition here (and to the spoken-copy
 * guard), never an accident.
 *
 * Evidence class: STRUCTURAL (the negative control shows the size check
 * reporting an oversized source).
 */
import { describe, it, expect } from 'vitest';
import path from 'path';
import { readdirSync, readFileSync } from 'fs';

const SHARED_DIR = path.resolve(__dirname, '../../../../src/ai/voice-turn/shared');
const MAX_LINES = 200;

const EXPECTED_HELPERS = [
  'blocked-caller-id.ts',
  'confirm-turn-answer.ts',
  'language-switch.ts',
  'low-stt-ladder.ts',
  'max-call-duration.ts',
  'owner-session.ts',
  'session-cost.ts',
  'session-timezone.ts',
];

function lineCount(source: string): number {
  return source.split('\n').length - (source.endsWith('\n') ? 1 : 0);
}

describe('#1601 step 2 — ai/voice-turn/shared/*', () => {
  it('is exactly the named set of helpers', () => {
    expect(readdirSync(SHARED_DIR).filter((f) => f.endsWith('.ts')).sort()).toEqual(EXPECTED_HELPERS);
  });

  for (const file of EXPECTED_HELPERS) {
    it(`${file} is under ${MAX_LINES} lines`, () => {
      const lines = lineCount(readFileSync(path.join(SHARED_DIR, file), 'utf8'));
      expect(lines, `${file}: ${lines} lines — split it or fold it into the pipeline`).toBeLessThanOrEqual(MAX_LINES);
    });
  }

  it('negative control — the size check reports an oversized source', () => {
    expect(lineCount(`${'x\n'.repeat(MAX_LINES)}y\n`)).toBeGreaterThan(MAX_LINES);
    expect(lineCount('x\n'.repeat(MAX_LINES))).toBe(MAX_LINES);
  });
});
