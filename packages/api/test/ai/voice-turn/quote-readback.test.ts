/**
 * WS5 — pure quote read-back unit matrix.
 *
 * These pin the EXACT strings the live voice agent speaks about money after
 * drafting an estimate. The invariant under test: a price is spoken ONLY when
 * every line is a clean catalog match; uncatalogued / ambiguous / unavailable
 * cases speak NO number; and at most one price is ever spoken.
 */
import { describe, it, expect } from 'vitest';
import {
  buildQuoteReadback,
  GENERIC_PROPOSAL_CONFIRMATION,
  UNCATALOGUED_QUOTE_READBACK,
  type QuoteReadbackLine,
} from '../../../src/ai/voice-turn/quote-readback';

const catalogLine = (
  description: string,
  unitPrice: number,
  quantity = 1,
): QuoteReadbackLine => ({ description, unitPrice, quantity, pricingSource: 'catalog' });

describe('buildQuoteReadback', () => {
  it('empty line items → generic confirmation (verbatim)', () => {
    expect(buildQuoteReadback({ lineItems: [], catalogAvailable: true })).toBe(
      GENERIC_PROPOSAL_CONFIRMATION,
    );
  });

  it('single catalogued line → one grounded price', () => {
    expect(
      buildQuoteReadback({
        lineItems: [catalogLine('Water Heater Replacement', 185000)],
        catalogAvailable: true,
      }),
    ).toBe(
      "For the Water Heater Replacement, that's typically $1850.00. I'll send the full quote to confirm.",
    );
  });

  it('single catalogued line honours quantity in the spoken total', () => {
    expect(
      buildQuoteReadback({
        lineItems: [catalogLine('Service Call', 12500, 2)],
        catalogAvailable: true,
      }),
    ).toBe("For the Service Call, that's typically $250.00. I'll send the full quote to confirm.");
  });

  it('multiple catalogued lines → the TOTAL only (never a per-line recital)', () => {
    const said = buildQuoteReadback({
      lineItems: [catalogLine('Water Heater Install', 85000), catalogLine('Gasket', 450, 2)],
      catalogAvailable: true,
    });
    expect(said).toBe(
      "That usually comes to about $859.00 all together. I'll send the full quote to confirm.",
    );
    // Exactly one dollar figure spoken.
    expect(said.match(/\$/g)).toHaveLength(1);
  });

  it('ANY uncatalogued line → NO numbers at all', () => {
    const said = buildQuoteReadback({
      lineItems: [
        catalogLine('Water Heater Install', 85000),
        { description: 'custom fabrication', pricingSource: 'uncatalogued' },
      ],
      catalogAvailable: true,
    });
    expect(said).toBe(UNCATALOGUED_QUOTE_READBACK);
    expect(said).not.toMatch(/\$/);
  });

  it('ANY ambiguous line → NO numbers at all', () => {
    const said = buildQuoteReadback({
      lineItems: [{ description: 'valve', pricingSource: 'ambiguous' }],
      catalogAvailable: true,
    });
    expect(said).toBe(UNCATALOGUED_QUOTE_READBACK);
    expect(said).not.toMatch(/\$/);
  });

  it('catalog unavailable → NO numbers even if a line looks priced', () => {
    const said = buildQuoteReadback({
      lineItems: [catalogLine('Water Heater Install', 85000)],
      catalogAvailable: false,
    });
    expect(said).toBe(UNCATALOGUED_QUOTE_READBACK);
    expect(said).not.toMatch(/\$/);
  });

  it('a catalog line missing its price is treated as un-priced → NO numbers', () => {
    const said = buildQuoteReadback({
      lineItems: [{ description: 'Water Heater Install', pricingSource: 'catalog' }],
      catalogAvailable: true,
    });
    expect(said).toBe(UNCATALOGUED_QUOTE_READBACK);
  });
});
