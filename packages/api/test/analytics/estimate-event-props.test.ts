import { describe, it, expect } from 'vitest';
import {
  estimateCreatedProps,
  estimateApprovedProps,
} from '../../src/analytics/estimate-event-props';
import type { LineItem } from '../../src/shared/billing-engine';

function line(overrides: Partial<LineItem> = {}): LineItem {
  return {
    id: overrides.id ?? 'li-1',
    description: overrides.description ?? 'Item',
    quantity: overrides.quantity ?? 1,
    unitPriceCents: overrides.unitPriceCents ?? 10000,
    ...overrides,
  } as LineItem;
}

describe('estimateCreatedProps', () => {
  it('counts total lines and lines carrying an image', () => {
    const props = estimateCreatedProps([
      line({ id: 'a', imageFileId: 'file-a' }),
      line({ id: 'b' }),
      line({ id: 'c', imageFileId: 'file-c' }),
    ]);
    expect(props.lineItemsTotal).toBe(3);
    expect(props.lineItemsWithImage).toBe(2);
  });

  it('reports tier groups by distinct groupKey', () => {
    const props = estimateCreatedProps([
      line({ id: 'a', groupKey: 'roof', isOptional: true }),
      line({ id: 'b', groupKey: 'roof', isOptional: true }),
      line({ id: 'c', groupKey: 'gutters', isOptional: true }),
    ]);
    expect(props.hasTiers).toBe(true);
    expect(props.tierGroupCount).toBe(2);
    // Tier options are never counted as standalone add-ons.
    expect(props.addonCount).toBe(0);
  });

  it('counts standalone add-ons (optional, no groupKey) separately from tiers', () => {
    const props = estimateCreatedProps([
      line({ id: 'a', groupKey: 'roof', isOptional: true }),
      line({ id: 'b', isOptional: true }), // add-on
      line({ id: 'c' }), // always-billed
    ]);
    expect(props.tierGroupCount).toBe(1);
    expect(props.addonCount).toBe(1);
  });

  it('a flat estimate has no tiers and no add-ons', () => {
    const props = estimateCreatedProps([line({ id: 'a' }), line({ id: 'b' })]);
    expect(props).toEqual({
      lineItemsTotal: 2,
      lineItemsWithImage: 0,
      hasTiers: false,
      tierGroupCount: 0,
      addonCount: 0,
    });
  });

  it('an empty estimate yields all zeros/false', () => {
    expect(estimateCreatedProps([])).toEqual({
      lineItemsTotal: 0,
      lineItemsWithImage: 0,
      hasTiers: false,
      tierGroupCount: 0,
      addonCount: 0,
    });
  });
});

describe('estimateApprovedProps', () => {
  it('flags images and tiers on the accepted estimate', () => {
    const props = estimateApprovedProps({
      lineItems: [line({ id: 'a', imageFileId: 'f', groupKey: 'roof' })],
      quotedTotalCents: 10000,
      acceptedTotalCents: 10000,
    });
    expect(props.hadLineItemImages).toBe(true);
    expect(props.hadTiers).toBe(true);
  });

  it('marks upsold when the accepted total exceeds the quoted default', () => {
    const props = estimateApprovedProps({
      lineItems: [line({ id: 'a', groupKey: 'roof' })],
      quotedTotalCents: 10000,
      acceptedTotalCents: 15000,
    });
    expect(props.upsoldAboveDefault).toBe(true);
  });

  it('does not mark upsold when the customer picks the default or a cheaper option', () => {
    expect(
      estimateApprovedProps({
        lineItems: [line({ id: 'a', groupKey: 'roof' })],
        quotedTotalCents: 10000,
        acceptedTotalCents: 10000,
      }).upsoldAboveDefault,
    ).toBe(false);
    expect(
      estimateApprovedProps({
        lineItems: [line({ id: 'a', groupKey: 'roof' })],
        quotedTotalCents: 10000,
        acceptedTotalCents: 8000,
      }).upsoldAboveDefault,
    ).toBe(false);
  });

  it('a flat estimate has no tiers, no images, and is never upsold', () => {
    expect(
      estimateApprovedProps({
        lineItems: [line({ id: 'a' })],
        quotedTotalCents: 10000,
        acceptedTotalCents: 10000,
      }),
    ).toEqual({ hadLineItemImages: false, hadTiers: false, upsoldAboveDefault: false });
  });
});
