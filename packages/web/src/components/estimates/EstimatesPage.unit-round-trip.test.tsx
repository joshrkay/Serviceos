/**
 * B7.5 (PR review, FINDING A) — the estimate editor must not drop `unit`.
 *
 * Same hazard as the invoice side: PgEstimateRepository.update DELETEs every
 * estimate_line_items row and re-INSERTs the payload (`item.unit ?? null`),
 * so a field absent from `apiLineToUi`/`uiLineToApi` is persisted as NULL on
 * lines nobody edited. These are the very functions the page calls — both on
 * the PUT save path and on the "accept AI suggestion" PATCH, which re-sends
 * every existing line through `uiLineToApi`.
 *
 * The raw-column proof lives in
 * packages/api/test/integration/line-item-unit-editor-round-trip.test.ts.
 */
import { describe, it, expect } from 'vitest';
import type { LineItem as EstimateLineItem } from '@ai-service-os/shared';
import { apiLineToUi, uiLineToApi } from './EstimatesPage';

const groundedLine: EstimateLineItem = {
  id: '33333333-3333-4333-8333-333333333333',
  description: 'Deck staining',
  quantity: 240,
  unit: 'sq ft',
  unitPriceCents: 375,
  totalCents: 90_000,
  sortOrder: 0,
  taxable: true,
};

const plainLine: EstimateLineItem = {
  id: '44444444-4444-4444-8444-444444444444',
  description: 'Prep labor',
  quantity: 3,
  unitPriceCents: 8_500,
  totalCents: 25_500,
  sortOrder: 1,
  taxable: true,
};

describe('EstimatesPage — B7.5 unit survives the editor round trip', () => {
  it('apiLineToUi carries the unit into the editor model', () => {
    expect(apiLineToUi(groundedLine).unit).toBe('sq ft');
  });

  it('uiLineToApi echoes the unit back into the save payload', () => {
    expect(uiLineToApi(apiLineToUi(groundedLine), 0).unit).toBe('sq ft');
  });

  it('editing a DIFFERENT line keeps the untouched line’s unit in the payload', () => {
    const editorRows = [groundedLine, plainLine].map(apiLineToUi);
    editorRows[1] = { ...editorRows[1], rate: 90 };

    const payload = editorRows.map((item, i) => uiLineToApi(item, i));

    expect(payload.find((l) => l.description === 'Deck staining')!.unit).toBe('sq ft');
    expect(payload.find((l) => l.description === 'Prep labor')!.unitPriceCents).toBe(9_000);
  });

  it('preserves the unit alongside the good-better-best metadata', () => {
    const tierLine: EstimateLineItem = {
      ...groundedLine,
      unit: 'sq ft',
      groupKey: 'staining',
      groupLabel: 'Staining package',
      isOptional: true,
      isDefaultSelected: true,
    };
    const payload = uiLineToApi(apiLineToUi(tierLine), 0);
    expect(payload.unit).toBe('sq ft');
    expect(payload.groupKey).toBe('staining');
    expect(payload.isDefaultSelected).toBe(true);
  });

  it('a line with no unit omits the key entirely (never sends null)', () => {
    const payload = uiLineToApi(apiLineToUi(plainLine), 0);
    expect(payload.unit).toBeUndefined();
    expect('unit' in payload).toBe(false);
  });

  it('the unit never enters money math — totals are qty × rate in integer cents', () => {
    const withUnit = uiLineToApi(apiLineToUi(groundedLine), 0);
    const withoutUnit = uiLineToApi(apiLineToUi({ ...groundedLine, unit: undefined }), 0);
    expect(withUnit.totalCents).toBe(withoutUnit.totalCents);
    expect(withUnit.totalCents).toBe(90_000);
    expect(Number.isInteger(withUnit.totalCents!)).toBe(true);
  });
});
