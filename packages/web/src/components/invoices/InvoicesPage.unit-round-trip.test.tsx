/**
 * B7.5 (PR review, FINDING A) — the invoice editor must not drop `unit`.
 *
 * PgInvoiceRepository.update DELETEs every invoice_line_items row and
 * re-INSERTs whatever the PUT body contains (`item.unit ?? null`). So the
 * editor's read→edit→write conversion IS the persistence contract: any field
 * missing from `apiLineToUi`/`uiLineToApi` is written back as NULL on every
 * line, including lines the operator never touched. That is silent data loss
 * on an unrelated edit, which is why this is pinned at the conversion
 * functions the page actually calls (line 96: `.map(apiLineToUi)`, and the
 * save at `updateInvoice({ lineItems: items.map(uiLineToApi) })`) rather than
 * at a copy of them.
 *
 * The server half — that this payload really lands in the raw column — is
 * pinned against real Postgres in
 * packages/api/test/integration/line-item-unit-editor-round-trip.test.ts.
 */
import { describe, it, expect } from 'vitest';
import type { LineItem as InvoiceLineItem } from '@ai-service-os/shared';
import { apiLineToUi, uiLineToApi } from './InvoicesPage';

const groundedLine: InvoiceLineItem = {
  id: '11111111-1111-4111-8111-111111111111',
  description: 'R-410A refrigerant',
  category: 'material',
  quantity: 4,
  unit: 'per lb',
  unitPriceCents: 3_200,
  totalCents: 12_800,
  sortOrder: 0,
  taxable: true,
};

const plainLine: InvoiceLineItem = {
  id: '22222222-2222-4222-8222-222222222222',
  description: 'Diagnostic labor',
  category: 'labor',
  quantity: 2,
  unitPriceCents: 9_500,
  totalCents: 19_000,
  sortOrder: 1,
  taxable: true,
};

describe('InvoicesPage — B7.5 unit survives the editor round trip', () => {
  it('apiLineToUi carries the unit into the editor model', () => {
    expect(apiLineToUi(groundedLine).unit).toBe('per lb');
  });

  it('uiLineToApi echoes the unit back into the save payload', () => {
    expect(uiLineToApi(apiLineToUi(groundedLine), 0).unit).toBe('per lb');
  });

  it('editing a DIFFERENT line keeps the untouched line’s unit in the PUT payload', () => {
    // Exactly what the page does: map the API rows into editor rows, mutate
    // one of them, then rebuild the whole array for the PUT.
    const editorRows = [groundedLine, plainLine].map(apiLineToUi);
    // Operator edits ONLY the labor line's rate.
    editorRows[1] = { ...editorRows[1], rate: 110 };

    const payload = editorRows.map((item, i) => uiLineToApi(item, i));

    const refrigerant = payload.find((l) => l.description === 'R-410A refrigerant')!;
    expect(refrigerant.unit).toBe('per lb');
    // The edit really happened — otherwise the assertion above is vacuous.
    expect(payload.find((l) => l.description === 'Diagnostic labor')!.unitPriceCents).toBe(11_000);
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
    expect(withUnit.unitPriceCents).toBe(withoutUnit.unitPriceCents);
    expect(withUnit.totalCents).toBe(12_800);
    expect(Number.isInteger(withUnit.totalCents)).toBe(true);
  });
});
