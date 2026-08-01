import { describe, expect, it } from 'vitest';
import { buildEdits, editableScalarFields, payloadLineItems } from './proposalEdit';

describe('editableScalarFields', () => {
  it('maps scalars to inputs, rendering cents as dollars', () => {
    const fields = editableScalarFields({
      customerName: 'Acme',
      amountCents: 12345,
      quantity: 3,
      lineItems: [{ description: 'x' }], // object → skipped (own editor)
      urgent: true, // boolean → skipped
      note: null, // null → skipped
    });
    expect(fields).toEqual([
      { key: 'customerName', label: 'Customer Name', kind: 'text', value: 'Acme' },
      { key: 'amountCents', label: 'Amount Cents', kind: 'cents', value: '123.45' },
      { key: 'quantity', label: 'Quantity', kind: 'number', value: '3' },
    ]);
  });

  it('returns [] for an empty/missing payload', () => {
    expect(editableScalarFields(undefined)).toEqual([]);
    expect(editableScalarFields({})).toEqual([]);
  });
});

describe('buildEdits', () => {
  const payload = { customerName: 'Acme', amountCents: 12345, quantity: 3 };

  it('sends only changed fields, parsing dollars back to integer cents', () => {
    const { edits, invalid } = buildEdits(payload, {
      customerName: 'Acme Corp',
      amountCents: '$1,299.50',
      quantity: '3', // unchanged → omitted
    });
    expect(invalid).toEqual([]);
    expect(edits).toEqual({ customerName: 'Acme Corp', amountCents: 129950 });
  });

  it('an untouched cents field round-trips without registering as an edit', () => {
    const { edits } = buildEdits(payload, { amountCents: '123.45' });
    expect(edits).toEqual({});
  });

  it('flags unparseable money/number input instead of sending it', () => {
    const { edits, invalid } = buildEdits(payload, {
      amountCents: 'twelve dollars',
      quantity: '',
    });
    expect(edits).toEqual({});
    expect(invalid).toEqual(['Amount Cents', 'Quantity']);
  });

  it('trims text edits', () => {
    const { edits } = buildEdits(payload, { customerName: '  Acme Corp  ' });
    expect(edits).toEqual({ customerName: 'Acme Corp' });
  });
});

describe('payloadLineItems', () => {
  it('returns well-shaped line items', () => {
    const items = payloadLineItems({
      lineItems: [
        { catalogItemId: 'c1', description: 'Heater', quantity: 1, unitPriceCents: 72000 },
        { description: 'Labor', quantity: 3, unitPriceCents: 12000 },
      ],
    });
    expect(items).toHaveLength(2);
    expect(items?.[0]).toEqual({
      catalogItemId: 'c1',
      description: 'Heater',
      quantity: 1,
      unitPriceCents: 72000,
    });
    expect(items?.[1].catalogItemId).toBeUndefined();
  });

  it('returns null for missing, empty, or malformed lists (no editor offered)', () => {
    expect(payloadLineItems(undefined)).toBeNull();
    expect(payloadLineItems({})).toBeNull();
    expect(payloadLineItems({ lineItems: [] })).toBeNull();
    expect(payloadLineItems({ lineItems: [{ description: 'x' }] })).toBeNull(); // no price/qty
    expect(payloadLineItems({ lineItems: ['nope'] })).toBeNull();
  });
});
