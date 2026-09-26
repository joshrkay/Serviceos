/**
 * #839 — baseline regression gate for the voice-eval harness
 * (packages/voice-eval/baseline.ts). Pure logic, no network, no tokens.
 *
 * The gate compares a run's metrics against a committed baseline file and
 * fails when any metric drops by more than the baseline's tolerance, when the
 * golden set the baseline describes has changed underneath it, or when the
 * baseline is still an unrecorded placeholder (fail closed — a placeholder is
 * an unmet prerequisite, never a green gate).
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  BASELINE_EXIT_NO_BASELINE,
  applyBaselineGate,
  buildBaseline,
  compareToBaseline,
  fingerprintGoldenSet,
  parseBaselineArgs,
  readBaseline,
  writeBaseline,
  type EvalBaseline,
  type EvalRunSummary,
} from '../../../voice-eval/baseline';

const run = (metrics: Record<string, number>, over: Partial<EvalRunSummary> = {}): EvalRunSummary => ({
  eval: 'intent',
  mode: 'offline',
  goldenSet: { rows: 3, fingerprint: fingerprintGoldenSet(['a', 'b', 'c']) },
  metrics,
  ...over,
});

const recorded = (metrics: Record<string, number>, tolerance = 0): EvalBaseline =>
  buildBaseline(run(metrics), { tolerance, recordedAt: '2026-09-26T00:00:00.000Z', recordCommand: 'npm run x' });

describe('fingerprintGoldenSet', () => {
  it('is order-independent and changes when any row changes', () => {
    expect(fingerprintGoldenSet(['a', 'b'])).toBe(fingerprintGoldenSet(['b', 'a']));
    expect(fingerprintGoldenSet(['a', 'b'])).not.toBe(fingerprintGoldenSet(['a', 'B']));
    expect(fingerprintGoldenSet(['a', 'b'])).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('compareToBaseline', () => {
  it('passes when every metric is at or above the baseline', () => {
    const v = compareToBaseline(recorded({ accuracy: 0.74, macroF1: 0.77 }), run({ accuracy: 0.74, macroF1: 0.78 }));
    expect(v.status).toBe('pass');
    expect(v.pass).toBe(true);
    expect(v.improvements.map((i) => i.metric)).toEqual(['macroF1']);
  });

  it('fails on any drop past the tolerance, naming the metric', () => {
    const v = compareToBaseline(recorded({ accuracy: 0.74, macroF1: 0.77 }), run({ accuracy: 0.73, macroF1: 0.77 }));
    expect(v.status).toBe('regressed');
    expect(v.pass).toBe(false);
    expect(v.regressions).toEqual([{ metric: 'accuracy', baseline: 0.74, current: 0.73, drop: expect.closeTo(0.01, 9) }]);
    expect(v.message).toMatch(/accuracy/);
  });

  it('tolerates a drop within tolerance (live noise) but not beyond it', () => {
    const base = recorded({ accuracy: 0.9 }, 0.04);
    expect(compareToBaseline(base, run({ accuracy: 0.86 })).pass).toBe(true);
    expect(compareToBaseline(base, run({ accuracy: 0.859 })).pass).toBe(false);
  });

  it('does not flake on float noise at zero tolerance', () => {
    const v = compareToBaseline(recorded({ accuracy: 0.1 + 0.2 }), run({ accuracy: 0.3 }));
    expect(v.pass).toBe(true);
  });

  it('fails when a baseline metric is missing from the run', () => {
    const v = compareToBaseline(recorded({ accuracy: 0.74, macroF1: 0.77 }), run({ accuracy: 0.8 }));
    expect(v.pass).toBe(false);
    expect(v.regressions.map((r) => r.metric)).toEqual(['macroF1']);
  });

  it('fails closed on an unrecorded placeholder baseline', () => {
    const placeholder: EvalBaseline = { ...recorded({}), status: 'placeholder', recordedAt: null, goldenSet: null };
    const v = compareToBaseline(placeholder, run({ accuracy: 0.99 }));
    expect(v.status).toBe('no-baseline');
    expect(v.pass).toBe(false);
    expect(v.message).toMatch(/npm run x/);
  });

  it('fails when the golden set changed under the baseline (re-record required)', () => {
    const base = recorded({ accuracy: 0.74 });
    const changed = run({ accuracy: 0.9 }, { goldenSet: { rows: 3, fingerprint: fingerprintGoldenSet(['a', 'b', 'd']) } });
    const v = compareToBaseline(base, changed);
    expect(v.status).toBe('golden-set-changed');
    expect(v.pass).toBe(false);
    expect(v.message).toMatch(/re-record/i);
  });

  it('refuses to compare across evals or modes', () => {
    const base = recorded({ accuracy: 0.74 });
    expect(compareToBaseline(base, run({ accuracy: 0.74 }, { mode: 'live' })).status).toBe('mismatch');
    expect(compareToBaseline(base, run({ accuracy: 0.74 }, { eval: 'slot' })).status).toBe('mismatch');
  });
});

describe('baseline file round-trip + validation', () => {
  it('writes and reads back an identical baseline', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-eval-baseline-'));
    const p = path.join(dir, 'b.json');
    const b = recorded({ accuracy: 0.74 });
    writeBaseline(p, b);
    expect(readBaseline(p)).toEqual(b);
    expect(fs.readFileSync(p, 'utf8').endsWith('\n')).toBe(true);
  });

  it('rejects a malformed baseline file instead of silently passing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-eval-baseline-'));
    const p = path.join(dir, 'bad.json');
    fs.writeFileSync(p, JSON.stringify({ schemaVersion: 1, eval: 'intent' }));
    expect(() => readBaseline(p)).toThrow(/baseline/i);
  });
});

describe('parseBaselineArgs', () => {
  it('parses both spellings of --baseline and --record-baseline', () => {
    expect(parseBaselineArgs(['--baseline', 'a.json'])).toEqual({ comparePath: 'a.json', recordPath: undefined });
    expect(parseBaselineArgs(['--record-baseline=b.json'])).toEqual({ comparePath: undefined, recordPath: 'b.json' });
    expect(parseBaselineArgs(['--live'])).toEqual({ comparePath: undefined, recordPath: undefined });
  });

  it('has a distinct exit code for "no baseline recorded"', () => {
    expect(BASELINE_EXIT_NO_BASELINE).toBe(4);
  });
});

describe('applyBaselineGate (runner wiring)', () => {
  const tmp = (): string => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'voice-eval-gate-')), 'b.json');
  const opts = { tolerance: 0, recordCommand: 'npm run rec', now: () => '2026-09-26T12:00:00.000Z' };

  it('is a no-op without --baseline / --record-baseline', () => {
    expect(applyBaselineGate(run({ accuracy: 0.5 }), {}, opts)).toEqual({ exitCode: 0, message: undefined });
  });

  it('--record-baseline writes a recorded baseline for the run', () => {
    const p = tmp();
    const r = applyBaselineGate(run({ accuracy: 0.74 }), { recordPath: p }, opts);
    expect(r.exitCode).toBe(0);
    const b = readBaseline(p);
    expect(b).toMatchObject({ status: 'recorded', recordedAt: '2026-09-26T12:00:00.000Z', metrics: { accuracy: 0.74 }, tolerance: 0 });
  });

  it('re-recording over a placeholder keeps its tolerance + record command', () => {
    const p = tmp();
    writeBaseline(p, { ...recorded({}), status: 'placeholder', recordedAt: null, goldenSet: null, tolerance: 0.04, recordCommand: 'owner cmd' });
    applyBaselineGate(run({ accuracy: 0.9 }), { recordPath: p }, opts);
    expect(readBaseline(p)).toMatchObject({ status: 'recorded', tolerance: 0.04, recordCommand: 'owner cmd' });
  });

  it('--baseline exits 0 on pass, 1 on regression, 4 on a placeholder', () => {
    const p = tmp();
    writeBaseline(p, recorded({ accuracy: 0.74 }));
    expect(applyBaselineGate(run({ accuracy: 0.74 }), { comparePath: p }, opts).exitCode).toBe(0);
    const bad = applyBaselineGate(run({ accuracy: 0.70 }), { comparePath: p }, opts);
    expect(bad.exitCode).toBe(1);
    expect(bad.message).toMatch(/regressed/);
    writeBaseline(p, { ...recorded({}), status: 'placeholder', recordedAt: null, goldenSet: null });
    expect(applyBaselineGate(run({ accuracy: 0.99 }), { comparePath: p }, opts).exitCode).toBe(BASELINE_EXIT_NO_BASELINE);
  });

  it('a golden-set change fails the compare (exit 1)', () => {
    const p = tmp();
    writeBaseline(p, recorded({ accuracy: 0.74 }));
    const moved = run({ accuracy: 0.74 }, { goldenSet: { rows: 4, fingerprint: fingerprintGoldenSet(['a', 'b', 'c', 'd']) } });
    expect(applyBaselineGate(moved, { comparePath: p }, opts).exitCode).toBe(1);
  });
});

describe('golden-set keys (corpus.ts)', () => {
  it('an intent relabel or a slot-gold edit changes the key', async () => {
    const { intentGoldenKey, slotGoldenKey } = await import('../../../voice-eval/corpus');
    expect(intentGoldenKey({ utterance: 'bill acme', intent: 'create_invoice' }))
      .not.toBe(intentGoldenKey({ utterance: 'bill acme', intent: 'send_invoice' }));
    const t = { transcript: 'hi', service_type: 'hvac', expected_entities: { address: '1 Main' } };
    expect(slotGoldenKey(t)).toBe(slotGoldenKey({ ...t }));
    expect(slotGoldenKey(t)).not.toBe(slotGoldenKey({ ...t, expected_entities: { address: '2 Main' } }));
    expect(slotGoldenKey(t)).not.toBe(slotGoldenKey({ ...t, service_type: 'plumbing' }));
  });
});
