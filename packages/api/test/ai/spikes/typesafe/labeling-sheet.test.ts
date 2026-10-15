import { describe, expect, it } from 'vitest';
import { buildLabelingSheet, toCsv, type JudgedRow } from '../../../../src/ai/spikes/typesafe/labeling-sheet';

const row = (text: string, baseline: boolean, typesafe: boolean, probability = 0.5): JudgedRow => ({
  text,
  baseline,
  typesafe,
  probability,
});

describe('buildLabelingSheet', () => {
  it('puts every disagreement in the sheet, classified and ahead of sampled agreements', () => {
    const rows = [
      row('agree-no', false, false, 0.05),
      row('ts-only', false, true, 0.9),
      row('base-only', true, false, 0.2),
      row('agree-yes', true, true, 0.95),
    ];
    const sheet = buildLabelingSheet(rows, { agreementSample: 2, seed: 1 });

    expect(sheet.slice(0, 2).map((r) => [r.text, r.kind])).toEqual([
      ['ts-only', 'typesafe_only'],
      ['base-only', 'baseline_only'],
    ]);
    expect(sheet.map((r) => r.text).sort()).toEqual(['agree-no', 'agree-yes', 'base-only', 'ts-only']);
    expect(sheet.every((r) => r.label === '')).toBe(true);
  });

  it('samples a fixed number of agreements, deterministically for a seed', () => {
    const rows = Array.from({ length: 40 }, (_, i) => row(`neg-${i}`, false, false, 0.1));
    const a = buildLabelingSheet(rows, { agreementSample: 5, seed: 7 });
    const b = buildLabelingSheet(rows, { agreementSample: 5, seed: 7 });
    expect(a).toHaveLength(5);
    expect(a.map((r) => r.text)).toEqual(b.map((r) => r.text));
  });

  it('dedupes utterances that differ only by case and whitespace', () => {
    const rows = [row('Get me a manager', false, true, 0.9), row('  get me a   MANAGER ', false, true, 0.9)];
    expect(buildLabelingSheet(rows, { agreementSample: 0, seed: 1 })).toHaveLength(1);
  });
});

describe('toCsv', () => {
  it('quotes commas, quotes and newlines and leaves the label column empty', () => {
    const csv = toCsv([
      { text: 'he said "stop", twice\nthen left', kind: 'typesafe_only', baseline: false, typesafe: true, probability: 0.8, label: '' },
    ]);
    const lines = csv.split('\n');
    expect(lines[0]).toBe('text,kind,baseline,typesafe,probability,label');
    expect(csv).toContain('"he said ""stop"", twice\nthen left",typesafe_only,false,true,0.8,');
  });
});
